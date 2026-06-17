// Vision-LLM распознавание УПД. Используется для двух сценариев:
//  1. PDF-сканы без текстового слоя (fallback после PdfNoTextError);
//  2. Фото УПД в JPG/PNG/WEBP — пользователь сфотографировал бумажный экземпляр.
//
// В отличие от parseUpdPdf (текст → LLM) здесь прямой vision-вызов:
// файл отдаётся модели как изображение/PDF через inline_data parts (Gemini)
// или image_url data:base64 (OpenRouter). Возвращает тот же UpdPdfParsed,
// что и текстовый парсер, — благодаря единой Zod-схеме контракта Vision
// и Text парсеры взаимозаменяемы на уровне worker'а.
//
// Поддерживаемые провайдеры — те же, что и waybill-batch:
//  - google_ai_studio — понимает application/pdf через inline_data;
//  - openrouter — только image/* (PDF не поддерживается провайдером).
// Если default-провайдер = openrouter и пришёл PDF — выбрасываем явную
// ошибку, чтобы worker мог пометить документ parse_failed с понятным
// сообщением.
//
// Схема ответа продублирована из upd-pdf.parser.ts (локальная константа
// RESPONSE_JSON_SCHEMA там не экспортирована). Намеренно не вытаскиваем
// в общий модуль — дублирование <120 строк JSON Schema проще держать
// рядом с каждым парсером, чем городить shared/-зависимость.

import { z } from 'zod';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import type { ParsePdfResult } from './upd-pdf.parser.js';

// JSON Schema ответа Gemini — должна совпадать с UpdPdfParsedSchema в
// контрактах. Дублирование такое же, как в upd-pdf.parser.ts → если
// контракт расширяется, оба места обновлять синхронно.
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['items', 'confidence'],
  properties: {
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalSum: { type: ['number', 'null'] },
    vatSum: { type: ['number', 'null'] },
    itemsCount: { type: ['integer', 'null'] },
    supplier: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    recipient: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nameRaw', 'qty', 'unit'],
        properties: {
          nameRaw: { type: 'string' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          price: { type: ['number', 'null'] },
          sum: { type: ['number', 'null'] },
          vatRate: { type: ['number', 'null'] },
          vatSum: { type: ['number', 'null'] },
          volumeM3: { type: ['number', 'null'] },
          massKg: { type: ['number', 'null'] },
          volumeConfidence: {
            type: ['string', 'null'],
            enum: ['low', 'medium', 'high', null],
          },
          groupName: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export type UpdVisionInput = {
  buffer: Buffer;
  mimeType: string;
  filename?: string | null;
};

/**
 * Парсит УПД через vision-LLM. Возвращает то же `ParsePdfResult`, что и
 * `parseUpdPdf`, — на уровне worker.ts оба парсера взаимозаменяемы.
 *
 * При ошибках провайдера / непарсимом JSON / валидации — бросает исключение
 * (worker сам пометит документ parse_failed через стандартный retry-механизм
 * очереди, как у текстового parseUpdPdf).
 *
 * textLength в результате = размер base64 файла (для совместимости с типом;
 * пользователю это поле не показывается, оно только в логи).
 */
export async function parseUpdVision(
  input: UpdVisionInput,
  ctx: { sourceDocumentId: string | null } = { sourceDocumentId: null },
): Promise<ParsePdfResult> {
  const mime = input.mimeType.toLowerCase();
  if (!SUPPORTED_MIMES.has(mime)) {
    throw new Error(`parseUpdVision: неподдерживаемый MIME ${input.mimeType}`);
  }

  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error('УПД vision: не настроен default LLM-провайдер');
  }
  if (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter') {
    throw new Error(
      `УПД vision: распознавание из изображения не поддерживается провайдером ${row.kind}. ` +
        'Используйте Google AI Studio или OpenRouter.',
    );
  }
  if (row.kind === 'openrouter' && mime === 'application/pdf') {
    throw new Error(
      'УПД vision через OpenRouter: PDF не поддерживается провайдером. ' +
        'Переключите default-провайдера на Google AI Studio или загрузите файл как JPG/PNG.',
    );
  }

  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error(`УПД vision: не задан API-ключ провайдера ${row.kind}`);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  // Используем тот же prompt doc_kind='upd', что и текстовый parser.
  const promptMeta = await loadActivePromptWithMeta('upd');

  const startedAt = Date.now();
  let raw: string | null = null;
  let parsedZod: UpdPdfParsed | null = null;
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
        file: { buffer: input.buffer, mimeType: mime },
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
        file: { buffer: input.buffer, mimeType: mime },
      });
      raw = result.raw;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
    }

    if (!raw) throw new Error('УПД vision: пустой ответ LLM');

    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(stripJsonFences(raw));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      e.message = `УПД vision: JSON.parse failed (likely truncated): ${e.message}`;
      throw e;
    }
    parsedZod = UpdPdfParsedSchema.parse(jsonParsed);
    return {
      parsed: parsedZod,
      textLength: input.buffer.length,
      llmProviderId: row.id,
    };
  } catch (err) {
    errorCode = err instanceof z.ZodError ? 'zod_failed' : 'provider_error';
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const latencyMs = Date.now() - startedAt;
    // Логируем без request-картинки (base64 огромный), как в waybill-batch.
    try {
      await db.insert(llmCalls).values({
        sourceDocumentId: ctx.sourceDocumentId,
        providerId: row.id,
        promptId: promptMeta.id,
        docKind: 'upd',
        model: row.model,
        requestMessages: [
          {
            role: 'user',
            content: `[vision upd: ${input.filename ?? 'no-name'} (${mime}, ${input.buffer.length} bytes)]\n${promptMeta.content.slice(0, 4000)}`,
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
  file: { buffer: Buffer; mimeType: string };
};

type VisionCallResult = {
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

async function callGemini(args: VisionCallArgs): Promise<VisionCallResult> {
  const parts: Array<{ inline_data: { mime_type: string; data: string } } | { text: string }> = [
    {
      inline_data: {
        mime_type: args.file.mimeType,
        data: args.file.buffer.toString('base64'),
      },
    },
    { text: args.promptText },
  ];

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
  const dataUrl = `data:${args.file.mimeType};base64,${args.file.buffer.toString('base64')}`;
  const content: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [
    { type: 'image_url', image_url: { url: dataUrl } },
    { type: 'text', text: args.promptText },
  ];

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
