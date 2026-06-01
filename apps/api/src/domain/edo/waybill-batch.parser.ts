// Vision-LLM распознавание пакета накладных. Поддерживает обе формы:
//  - ТН (форма РФ 2116) — материалы извне на стройку.
//  - ОС-2 (внутреннее перемещение основных средств).
//
// В отличие от УПД, где работает pdf-parse (текст → LLM), накладные приходят
// фотопакетом. Поэтому здесь прямой vision-вызов: все изображения отдаются
// модели одним запросом, она классифицирует каждый файл (ТН / ОС-2 / игнор)
// и возвращает массив `documents` с явной формой и полями.
//
// Поддерживаются два провайдера:
//  - google_ai_studio — прямое подключение к Gemini API, передаём
//    изображения через inline_data parts. Понимает application/pdf.
//  - openrouter — OpenAI-совместимый Chat Completions с vision: фото идут
//    через image_url data:base64. PDF не поддерживается провайдером —
//    для смешанных пакетов придётся выбирать Gemini напрямую.
//
// Один пакет → N source_documents в БД. См. worker.handleWaybillBundleJob.

import { z } from 'zod';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  WaybillBatchParsedSchema,
  type WaybillBatchParsed,
} from '@matcheck/contracts';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { buildAad, decryptField } from '../auth/crypto.js';

// JSON-схема ответа для Gemini responseSchema. Дублируем структуру
// WaybillBatchParsedSchema из контрактов в JSON Schema формате.
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      items: {
        type: 'object',
        required: ['form', 'items', 'confidence'],
        properties: {
          form: { type: 'string', enum: ['tn_2116', 'os2'] },
          docNumber: { type: ['string', 'null'] },
          docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
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
          sender: {
            type: ['object', 'null'],
            properties: {
              name: { type: ['string', 'null'] },
              department: { type: ['string', 'null'] },
            },
          },
          recipient: {
            type: ['object', 'null'],
            properties: {
              name: { type: ['string', 'null'] },
              department: { type: ['string', 'null'] },
            },
          },
          totalSum: { type: ['number', 'null'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['nameRaw'],
              properties: {
                nameRaw: { type: 'string' },
                qty: { type: ['number', 'null'] },
                unit: { type: ['string', 'null'] },
                invNumber: { type: ['string', 'null'] },
                price: { type: ['number', 'null'] },
                sum: { type: ['number', 'null'] },
              },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

export type ParseWaybillBatchResult = {
  parsed: WaybillBatchParsed;
  llmProviderId: string | null;
};

export type WaybillInputImage = {
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
 * Парсит пакет файлов через vision-LLM. Возвращает массив найденных
 * документов с явной формой (`tn_2116` / `os2`). Пустой массив = ничего
 * распознаваемого в пакете не найдено.
 *
 * Логирование в llmCalls — без request-изображений (они огромные в base64),
 * только промпт + ответ + токены.
 */
export async function parseWaybillBatch(
  files: WaybillInputImage[],
  ctx: { sourceDocumentId: string | null; bundleId: string | null },
): Promise<ParseWaybillBatchResult> {
  if (files.length === 0) {
    throw new Error('parseWaybillBatch: пустой пакет файлов');
  }
  for (const f of files) {
    if (!SUPPORTED_MIMES.has(f.mimeType.toLowerCase())) {
      throw new Error(
        `parseWaybillBatch: неподдерживаемый MIME ${f.mimeType} у файла ${f.filename}`,
      );
    }
  }

  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error('Накладные: не настроен default LLM-провайдер');
  }
  if (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter') {
    throw new Error(
      `Накладные: vision не поддерживается провайдером ${row.kind}. ` +
        'Используйте Google AI Studio или OpenRouter.',
    );
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error(`Накладные: не задан API-ключ провайдера ${row.kind}`);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  // Промпт лежит в БД под doc_kind='transport_waybill' для совместимости
  // с существующей админкой; контент промпта (default v2+) уже мульти-формный.
  const promptMeta = await loadActivePromptWithMeta('transport_waybill');

  // OpenRouter vision не принимает application/pdf — только image_url.
  if (row.kind === 'openrouter') {
    const pdfs = files.filter((f) => f.mimeType.toLowerCase() === 'application/pdf');
    if (pdfs.length > 0) {
      throw new Error(
        `Накладные через OpenRouter: PDF не поддерживается (${pdfs.map((f) => f.filename).join(', ')}). ` +
          'Загрузите только фото JPG/PNG/WEBP или переключите default-провайдера на Google AI Studio.',
      );
    }
  }

  const startedAt = Date.now();
  let raw: string | null = null;
  let parsedZod: WaybillBatchParsed | null = null;
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
        maxTokens: row.maxTokens ?? 8192,
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
        maxTokens: row.maxTokens ?? 8192,
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
    parsedZod = WaybillBatchParsedSchema.parse(jsonParsed);
    return { parsed: parsedZod, llmProviderId: row.id };
  } catch (err) {
    errorCode = err instanceof z.ZodError ? 'zod_failed' : 'provider_error';
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const latencyMs = Date.now() - startedAt;
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
            content: `[bundle=${ctx.bundleId ?? '-'} ${files.length} image(s): ${files.map((f) => f.filename).join(', ')}]\n${promptMeta.content.slice(0, 4000)}`,
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
  files: WaybillInputImage[];
};

type VisionCallResult = {
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

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

function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const noLead = trimmed.replace(/^```(?:json)?\s*/i, '');
  return noLead.replace(/\s*```\s*$/i, '');
}
