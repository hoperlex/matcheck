import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';

/**
 * Распознавание позиций из ОДНОГО фото-документа для split-view модалки
 * в Принятых (раздел Приёмка/Отгрузка → клик на фото с kind='document').
 *
 * Отличия от parseWaybillBatch:
 *   - НЕ требуется классификация формы (tn_2116 vs os2 vs прочее).
 *   - Терпимый промпт: если форма нестандартная или фото с наклоном —
 *     извлекаем то, что видно, не отвергаем «как непознанное».
 *   - Один файл на вход (не пакет), один результат — JSON {items, ...}.
 *   - Промпт прошит в код (не из БД admin Промпты), чтобы менеджер
 *     случайно не сломал split-view, правя промпт под накладные.
 *
 * Поддерживаются два провайдера, как в parseWaybillBatch:
 *   - google_ai_studio — прямой Gemini API (inline_data parts);
 *   - openrouter — OpenAI-совместимый Chat Completions с vision (image_url
 *     data:base64). PDF в OpenRouter не работает, но split-view распознаёт
 *     только фото (kind='document' приходит с камеры мобильного), так что
 *     ограничение здесь нерелевантно.
 */

const PROMPT = `Ты — ассистент, который извлекает табличные данные из фото документа.

На фото — товарно-транспортная накладная, ТТН формы 1-Т, ОС-2, товарная накладная, акт приёмки, рукописная накладная или подобный документ. Фото может быть под наклоном, с тенями, с рукописными пометками сверху или сбоку, частично за пределами кадра — это нормально.

Твоя задача — извлечь все позиции из табличной части документа (наименование товара/материала, количество, единица измерения, цена, сумма).

ПРАВИЛА:
1. НЕ отвергай документ из-за нестандартной формы или плохого качества фото. Если видишь хотя бы одну строку таблицы — извлекай её.
2. Если рядом с табличной частью есть рукописные правки/итоги — игнорируй их (бери только то, что в напечатанной таблице).
3. Если на фото только шапка/подписи документа без таблицы (например, последняя страница многостраничной накладной с подписями и печатями) — верни пустой items.
4. Числа: цена и сумма — в рублях. Используй точку как десятичный разделитель (1234.56, не 1 234,56).
5. Единицы: оставь как написано в документе ("шт", "кг", "м", "м3", "т" и т.п.); не переводи.

Верни строго JSON по схеме:
{
  "items": [
    { "nameRaw": "название позиции", "qty": число|null, "unit": "ед"|null, "price": число|null, "sum": число|null, "invNumber": "артикул"|null }
  ],
  "docForm": "tn_2116"|"os2"|"other"|null,
  "docNumber": "номер документа"|null,
  "docDate": "YYYY-MM-DD"|null,
  "totalSum": число|null,
  "confidence": число от 0 до 1
}

Если совсем ничего нельзя извлечь (фото нечитаемо целиком): { "items": [], "confidence": 0, "docForm": null, "docNumber": null, "docDate": null, "totalSum": null }.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['items', 'confidence'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nameRaw'],
        properties: {
          nameRaw: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          price: { type: ['number', 'null'] },
          sum: { type: ['number', 'null'] },
          invNumber: { type: ['string', 'null'] },
        },
      },
    },
    docForm: { type: ['string', 'null'] },
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'] },
    totalSum: { type: ['number', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const ResultSchema = z.object({
  items: z.array(
    z.object({
      nameRaw: z.string(),
      qty: z.number().nullable().optional(),
      unit: z.string().nullable().optional(),
      price: z.number().nullable().optional(),
      sum: z.number().nullable().optional(),
      invNumber: z.string().nullable().optional(),
    }),
  ),
  docForm: z.string().nullable().optional(),
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(),
  totalSum: z.number().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type RecognizePhotoResult = {
  items: z.infer<typeof ResultSchema>['items'];
  docForm: string | null;
  docNumber: string | null;
  docDate: string | null;
  totalSum: number | null;
  confidence: number | null;
  model: string | null;
  rawResponse: string; // для записи в errorMessage при пустом items — диагностика
};

export async function recognizePhotoItems(
  buffer: Buffer,
  mimeType: string,
): Promise<RecognizePhotoResult> {
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider) throw new Error('LLM: не настроен default-провайдер');
  if (provider.kind !== 'google_ai_studio' && provider.kind !== 'openrouter') {
    throw new Error(
      `Распознавание фото-документа: vision не поддерживается провайдером ${provider.kind}. ` +
        'Переключите default в Администрировании → LLM провайдеры на Google AI Studio или OpenRouter.',
    );
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) throw new Error(`LLM: не задан API-ключ ${provider.kind}`);
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );

  const callArgs = {
    apiBaseUrl: cred.apiBaseUrl,
    apiKey,
    model: provider.model,
    temperature: Number(provider.temperature ?? 0.2),
    maxTokens: provider.maxTokens ?? 8192,
    buffer,
    mimeType,
  };
  const raw =
    provider.kind === 'google_ai_studio'
      ? await callGemini(callArgs)
      : await callOpenRouter(callArgs);
  if (!raw) throw new Error(`${provider.kind}: пустой ответ`);

  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let jsonParsed: unknown;
  try {
    jsonParsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `${provider.kind}: ответ не разобрался как JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = ResultSchema.parse(jsonParsed);

  return {
    items: validated.items,
    docForm: validated.docForm ?? null,
    docNumber: validated.docNumber ?? null,
    docDate: validated.docDate ?? null,
    totalSum: validated.totalSum ?? null,
    confidence: validated.confidence ?? null,
    model: provider.model,
    rawResponse: raw.slice(0, 2000),
  };
}

type CallArgs = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  buffer: Buffer;
  mimeType: string;
};

async function callGemini(args: CallArgs): Promise<string> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: args.mimeType, data: args.buffer.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: args.temperature,
      maxOutputTokens: args.maxTokens,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/v1beta/models/${args.model}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOpenRouter(args: CallArgs): Promise<string> {
  // OpenRouter vision: image_url с data:base64. PDF не поддерживается
  // (см. parseWaybillBatch), но фото-документ всегда image — для split-view
  // это безопасно. Если попадёт PDF — модель просто вернёт пустой items
  // или ошибку content-type на стороне провайдера.
  const dataUrl = `data:${args.mimeType};base64,${args.buffer.toString('base64')}`;
  const body = {
    model: args.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    response_format: { type: 'json_object' as const },
  };
  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
      'HTTP-Referer': 'https://matcheck.local',
      'X-Title': 'matcheck',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? '';
}
