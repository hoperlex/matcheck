// Распознавание Транспортной накладной (форма РФ 2116) через vision-LLM.
//
// В отличие от УПД, где работает pdf-parse (текст → LLM), ТН приходит как
// фото листа на телефон — текстового слоя нет. Поэтому здесь прямой
// vision-вызов: изображения отдаются модели как inline_data parts, и она
// сама распознаёт текст + классифицирует документы пакета.
//
// Поддерживаются два провайдера:
//  - google_ai_studio — прямое подключение к Gemini API, передаём
//    изображения через inline_data parts. Понимает application/pdf.
//  - openrouter — OpenAI-совместимый Chat Completions с vision: фото идут
//    через image_url data:base64. PDF не поддерживается провайдером —
//    для смешанных пакетов придётся выбирать Gemini напрямую.

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

  // Загружаем default provider напрямую — нам нужен vision-specific API,
  // существующий LlmProvider.complete() работает только с текстом.
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error('Транспортные накладные: не настроен default LLM-провайдер');
  }
  if (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter') {
    throw new Error(
      `Транспортные накладные: vision не поддерживается провайдером ${row.kind}. ` +
        'Используйте Google AI Studio или OpenRouter.',
    );
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error(`Транспортные накладные: не задан API-ключ провайдера ${row.kind}`);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  const promptMeta = await loadActivePromptWithMeta('transport_waybill');

  // OpenRouter vision не принимает application/pdf — только image_url.
  // Сейчас не делаем серверный PDF→image rendering (нужен pdfjs/imagemagick),
  // поэтому в этом сценарии явно сообщаем пользователю.
  if (row.kind === 'openrouter') {
    const pdfs = files.filter((f) => f.mimeType.toLowerCase() === 'application/pdf');
    if (pdfs.length > 0) {
      throw new Error(
        `Транспортные накладные через OpenRouter: PDF не поддерживается (${pdfs.map((f) => f.filename).join(', ')}). ` +
          'Загрузите только фото JPG/PNG/WEBP или переключите default-провайдера на Google AI Studio.',
      );
    }
  }

  const startedAt = Date.now();
  let raw: string | null = null;
  let parsedZod: TransportWaybillParsed | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    if (row.kind === 'google_ai_studio') {
      const result = await callGemini({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        temperature: Number(row.temperature ?? 0.2),
        maxTokens: row.maxTokens ?? 4096,
        promptText: promptMeta.content,
        files,
      });
      raw = result.raw;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    } else {
      const result = await callOpenRouter({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        temperature: Number(row.temperature ?? 0.2),
        maxTokens: row.maxTokens ?? 4096,
        promptText: promptMeta.content,
        files,
      });
      raw = result.raw;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    }

    if (!raw) throw new Error('vision LLM: пустой ответ');

    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(stripJsonFences(raw));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.message = `vision LLM: JSON.parse failed (likely truncated): ${e.message}`;
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

type VisionCallArgs = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  promptText: string;
  files: TransportWaybillInputImage[];
};

type VisionCallResult = {
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

/**
 * Прямой вызов Google AI Studio. Изображения и PDF — через inline_data
 * parts, ответ форсим в JSON через responseSchema.
 */
async function callGemini(args: VisionCallArgs): Promise<VisionCallResult> {
  const parts: Array<{ inline_data: { mime_type: string; data: string } } | { text: string }> = [];
  for (const f of args.files) {
    parts.push({
      inline_data: {
        mime_type: f.mimeType,
        data: f.buffer.toString('base64'),
      },
    });
  }
  parts.push({ text: args.promptText });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: args.temperature,
      maxOutputTokens: args.maxTokens,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_JSON_SCHEMA,
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
    throw new Error(`Gemini vision HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
  return {
    raw: json.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    promptTokens: json.usageMetadata?.promptTokenCount ?? null,
    completionTokens: json.usageMetadata?.candidatesTokenCount ?? null,
  };
}

/**
 * Вызов OpenRouter (OpenAI-совместимый Chat Completions). Изображения
 * передаются как image_url с data: base64. Просим JSON через
 * response_format=json_object — большинство vision-моделей это поддерживают.
 */
async function callOpenRouter(args: VisionCallArgs): Promise<VisionCallResult> {
  const content: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  for (const f of args.files) {
    const dataUrl = `data:${f.mimeType};base64,${f.buffer.toString('base64')}`;
    content.push({ type: 'image_url', image_url: { url: dataUrl } });
  }
  content.push({ type: 'text', text: args.promptText });

  const body = {
    model: args.model,
    messages: [{ role: 'user', content }],
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
    throw new Error(`OpenRouter vision HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    raw: json.choices?.[0]?.message?.content ?? '',
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
  };
}

/**
 * Некоторые модели через OpenRouter оборачивают JSON в ```json … ```
 * несмотря на response_format. Снимаем обёртку, если есть.
 */
function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const noLead = trimmed.replace(/^```(?:json)?\s*/i, '');
  return noLead.replace(/\s*```\s*$/i, '');
}
