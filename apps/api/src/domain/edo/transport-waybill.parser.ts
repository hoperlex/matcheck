// Распознавание Транспортной накладной (форма РФ 2116) через vision-LLM.
//
// В отличие от УПД, где работает pdf-parse (текст → LLM), ТН приходит как
// фото листа на телефон — текстового слоя нет. Поэтому здесь прямой
// vision-вызов: изображения отдаются модели как inline_data parts, и она
// сама распознаёт текст + классифицирует документы пакета.
//
// Сейчас поддерживается ТОЛЬКО Google AI Studio (Gemini). У OpenRouter
// vision тоже есть, но добавим позднее, если потребуется. Если default
// провайдер не Gemini — бросим ошибку.

import { z } from 'zod';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  TransportWaybillParsedSchema,
  type TransportWaybillParsed,
} from '@matcheck/contracts';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { buildAad, decryptField } from '../auth/crypto.js';

// JSON-схема ответа Gemini — точно соответствует TransportWaybillParsedSchema.
// Дублируем явно, потому что Gemini требует JSON-schema, а не Zod.
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['found', 'items', 'confidence'],
  properties: {
    found: { type: 'boolean' },
    docNumber: { type: ['string', 'null'] },
    docDate: {
      type: ['string', 'null'],
      description: 'YYYY-MM-DD',
    },
    shipper: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    consignee: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nameRaw'],
        properties: {
          nameRaw: { type: 'string' },
          qty: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export type ParseTransportWaybillResult = {
  parsed: TransportWaybillParsed;
  llmProviderId: string | null;
};

export type TransportWaybillInputImage = {
  buffer: Buffer;
  mimeType: string; // image/jpeg | image/png | image/webp | application/pdf
  filename: string;
};

const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/**
 * Парсит пакет файлов через Gemini vision. Все файлы отдаются одним
 * запросом — модель сама классифицирует и собирает данные из печатной ТН.
 *
 * Логирование в llmCalls — как в loggedComplete для УПД.
 */
export async function parseTransportWaybill(
  files: TransportWaybillInputImage[],
  ctx: { sourceDocumentId: string | null },
): Promise<ParseTransportWaybillResult> {
  if (files.length === 0) {
    throw new Error('parseTransportWaybill: пустой пакет файлов');
  }
  for (const f of files) {
    if (!SUPPORTED_MIMES.has(f.mimeType.toLowerCase())) {
      throw new Error(
        `parseTransportWaybill: неподдерживаемый MIME ${f.mimeType} у файла ${f.filename}`,
      );
    }
  }

  // Загружаем provider напрямую — нам нужен Gemini-specific vision API,
  // существующий LlmProvider.complete() работает только с текстом.
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error('Транспортные накладные: не настроен default LLM-провайдер');
  }
  if (row.kind !== 'google_ai_studio') {
    throw new Error(
      `Транспортные накладные требуют Gemini (Google AI Studio), но default провайдер — ${row.kind}. ` +
        'Настройте Gemini как default в админке.',
    );
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error('Транспортные накладные: не задан API-ключ Gemini');
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  const promptMeta = await loadActivePromptWithMeta('transport_waybill');

  // Парты запроса: inline_data для каждого изображения + текст-промпт.
  // Gemini принимает несколько изображений в одном вызове.
  const parts: Array<{ inline_data: { mime_type: string; data: string } } | { text: string }> = [];
  for (const f of files) {
    parts.push({
      inline_data: {
        mime_type: f.mimeType,
        data: f.buffer.toString('base64'),
      },
    });
  }
  parts.push({ text: promptMeta.content });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: Number(row.temperature ?? 0.2),
      maxOutputTokens: row.maxTokens ?? 4096,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_JSON_SCHEMA,
    },
  };

  const url = `${cred.apiBaseUrl.replace(/\/$/, '')}/v1beta/models/${row.model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const startedAt = Date.now();
  let raw: string | null = null;
  let parsedZod: TransportWaybillParsed | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini vision HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!raw) throw new Error('Gemini vision: empty content');
    promptTokens = json.usageMetadata?.promptTokenCount ?? null;
    completionTokens = json.usageMetadata?.candidatesTokenCount ?? null;

    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(raw);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.message = `Gemini vision: JSON.parse failed (likely truncated): ${e.message}`;
      throw e;
    }
    parsedZod = TransportWaybillParsedSchema.parse(jsonParsed);
    return { parsed: parsedZod, llmProviderId: row.id };
  } catch (err) {
    errorCode = err instanceof z.ZodError ? 'zod_failed' : 'provider_error';
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const latencyMs = Date.now() - startedAt;
    // Журналим как делает loggedComplete для УПД — без request-картинок
    // (они огромные в base64), только промпт + ответ + токены.
    try {
      await db.insert(llmCalls).values({
        sourceDocumentId: ctx.sourceDocumentId,
        providerId: row.id,
        promptId: promptMeta.id,
        docKind: 'transport_waybill',
        model: row.model,
        requestMessages: [
          {
            role: 'user',
            content: `[${files.length} image(s): ${files.map((f) => f.filename).join(', ')}]\n${promptMeta.content.slice(0, 4000)}`,
          },
        ],
        requestSchema: RESPONSE_JSON_SCHEMA as object,
        responseRaw: raw,
        responseParsed: parsedZod as unknown as object | null,
        promptTokens,
        completionTokens,
        latencyMs,
        errorCode,
        errorMessage,
      });
    } catch {
      /* ignore */
    }
  }
}
