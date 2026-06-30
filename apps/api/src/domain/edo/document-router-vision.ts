// Vision-доклассификация ТИПА документа для единого входа «Загрузить
// документы» (Этап 4). Вызывается ТОЛЬКО для файлов, которые
// детерминированный classifyFile пометил needsVision=true (фото/скан/
// неясный текст). Делает ОДИН дешёвый vision-вызов и отвечает на единственный
// вопрос: «что это за документ?» → {detectedKind, confidence}.
//
// ВАЖНО: это НЕ парсер. Здесь мы не извлекаем позиции и НЕ пишем операционные
// данные — только определяем тип, чтобы worker направил файл в существующий
// проверенный flow (УПД-vision / waybill-vision). Реальное извлечение делает
// тот же парсер, что и для «Загрузить УПД» / «Загрузить накладные».
//
// Принцип безопасности: при ЛЮБОЙ неуверенности (низкий confidence, тип не
// распознан, ошибка/таймаут провайдера) возвращаем unknown/0 — worker оставит
// файл в needs_review и НЕ создаст документ. Лучше лишняя ручная проверка, чем
// «тихо ТН как УПД».

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import { callOpenRouter, pdfToPngsViaPoppler, stripJsonFences } from './upd-vision.parser.js';
import type { DocClass } from './document-router.js';

// Сколько страниц PDF-скана рендерим под классификацию типа. Тип документа
// всегда виден на ПЕРВОЙ странице (шапка «Счёт-фактура» / «Транспортная
// накладная» / «Форма М-15»), поэтому одной достаточно — дёшево и быстро.
const ROUTER_CLASSIFY_MAX_PAGES = 1;

// Таймаут одной попытки классификации. Классификация — лёгкий запрос
// (1 картинка, ответ ~50 байт), 90 сек с запасом. Превышение → error →
// needs_review (документ не теряется, данные не пишутся).
const ROUTER_CLASSIFY_TIMEOUT_MS = 90_000;

const SUPPORTED_PROVIDER_KINDS = new Set(['google_ai_studio', 'openrouter']);

export type DocKindVisionResult = {
  detectedKind: DocClass;
  confidence: number; // 0..1
  raw: string | null;
  // Не null — классификацию выполнить не удалось (нет провайдера/ключа,
  // ошибка рендера/сети/таймаут). Worker трактует как needs_review.
  error: string | null;
  providerId: string | null;
  providerKind: string | null;
  pagesSent: number;
};

export const ROUTER_CLASSIFY_PROMPT = `Ты определяешь ТИП одного отсканированного или сфотографированного документа поставки материалов.
Не извлекай данные — только назови тип и оцени уверенность.

Верни СТРОГО один JSON-объект: {"kind":"<тип>","confidence":<число 0..1>}

Допустимые значения kind:
- "upd" — УПД, счёт-фактура или товарная накладная (ТОРГ-12): есть заголовок «Счёт-фактура №» / «Универсальный передаточный документ», табличная часть с позициями, продавец и покупатель, суммы и НДС.
- "transport_waybill" — транспортная или товарно-транспортная накладная: разделы «Грузоотправитель», «Перевозчик», «Приём груза», сведения о транспорте.
- "os2_transfer" — накладная на внутреннее перемещение объектов основных средств (унифицированная форма ОС-2).
- "m15" — требование-накладная М-15, «Типовая межотраслевая форма № М-15», «на отпуск материалов на сторону».
- "other" — всё прочее: фотография объекта/материала/упаковки, сертификат или паспорт качества, декларация соответствия, спецификация, доверенность, рукописная записка, нечитаемый или обрезанный кадр.

Правила:
- confidence — насколько ты уверен в типе (0..1). Если документ нечитаем, обрезан, это фото объекта или вообще не документ — ставь confidence не выше 0.5 и kind по лучшему предположению (обычно "other").
- Документ может быть повёрнут боком — всё равно классифицируй по содержимому.
- Верни ровно один JSON-объект, без markdown-ограждений и пояснений.`;

// JSON Schema ответа для Gemini (google_ai_studio). OpenRouter использует
// response_format json_object без схемы — там валидируем сами в parse.
const ROUTER_CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['kind', 'confidence'],
  properties: {
    kind: {
      type: 'string',
      enum: ['upd', 'transport_waybill', 'os2_transfer', 'm15', 'other'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

// Сырой строковый kind модели → DocClass. Всё неизвестное и 'other' → unknown.
export function mapVisionKind(k: string | undefined | null): DocClass {
  switch (k) {
    case 'upd':
      return 'upd';
    case 'transport_waybill':
      return 'transport_waybill';
    case 'os2_transfer':
      return 'os2_transfer';
    case 'm15':
      return 'm15';
    default:
      return 'unknown';
  }
}

/**
 * Разбирает сырой JSON-ответ классификатора в {kind, confidence}. Чистая,
 * детерминированная, тестируется офлайн. Терпима к array-обёртке (Gemini
 * preview иногда отдаёт [{…}]) и к мусору: на любой ошибке → unknown/0.
 */
export function parseRouterVisionRaw(raw: string | null): {
  kind: DocClass;
  confidence: number;
} {
  if (!raw) return { kind: 'unknown', confidence: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return { kind: 'unknown', confidence: 0 };
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object') return { kind: 'unknown', confidence: 0 };
  const o = parsed as { kind?: unknown; confidence?: unknown };
  const kind = mapVisionKind(typeof o.kind === 'string' ? o.kind : undefined);
  let confidence = typeof o.confidence === 'number' ? o.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  // unknown-тип не может быть «уверенным» — обнуляем confidence, чтобы он
  // никогда не прошёл порог авто-создания.
  if (kind === 'unknown') confidence = 0;
  return { kind, confidence };
}

/**
 * Определяет тип needsVision-файла одним vision-вызовом. Никогда не бросает:
 * на любой проблеме возвращает result.error≠null (worker → needs_review).
 * Реальный парсинг файла делает существующий flow после маршрутизации.
 */
export async function classifyFileVision(
  input: { buffer: Buffer; mimeType: string; filename: string | null },
  ctx: { sourceDocumentId?: string | null } = {},
): Promise<DocKindVisionResult> {
  const fail = (error: string, extra?: Partial<DocKindVisionResult>): DocKindVisionResult => ({
    detectedKind: 'unknown',
    confidence: 0,
    raw: null,
    error,
    providerId: extra?.providerId ?? null,
    providerKind: extra?.providerKind ?? null,
    pagesSent: extra?.pagesSent ?? 0,
  });

  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) return fail('не настроен default LLM-провайдер');
  if (!SUPPORTED_PROVIDER_KINDS.has(row.kind)) {
    return fail(`провайдер ${row.kind} не поддерживает vision-классификацию`, {
      providerId: row.id,
      providerKind: row.kind,
    });
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    return fail(`не задан API-ключ провайдера ${row.kind}`, {
      providerId: row.id,
      providerKind: row.kind,
    });
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );

  // ── Готовим изображение(я) под классификацию ──
  const mime = (input.mimeType || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(input.filename ?? '');
  let images: { buffer: Buffer; mimeType: string }[];
  try {
    if (isPdf) {
      const pngs = await pdfToPngsViaPoppler(input.buffer, ROUTER_CLASSIFY_MAX_PAGES);
      images = pngs.map((b) => ({ buffer: b, mimeType: 'image/png' }));
    } else {
      // Картинка (jpg/png/webp) или неизвестный формат — отдаём как есть.
      images = [{ buffer: input.buffer, mimeType: mime.startsWith('image/') ? mime : 'image/jpeg' }];
    }
  } catch (err) {
    return fail(`не удалось подготовить файл к классификации: ${errMsg(err)}`, {
      providerId: row.id,
      providerKind: row.kind,
    });
  }
  if (images.length === 0) {
    return fail('после рендера не осталось страниц для классификации', {
      providerId: row.id,
      providerKind: row.kind,
    });
  }

  // ── Один vision-вызов ──
  const startedAt = Date.now();
  let raw: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let error: string | null = null;
  try {
    if (row.kind === 'openrouter') {
      const r = await callOpenRouter({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        temperature: 0,
        maxTokens: 256,
        promptText: ROUTER_CLASSIFY_PROMPT,
        files: images,
      });
      raw = r.raw;
      promptTokens = r.promptTokens;
      completionTokens = r.completionTokens;
    } else {
      // google_ai_studio — отдаём первую страницу как inline_data.
      const r = await callGeminiClassify({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        file: images[0]!,
      });
      raw = r.raw;
      promptTokens = r.promptTokens;
      completionTokens = r.completionTokens;
    }
  } catch (err) {
    error = errMsg(err);
  }

  // ── Журнал в llm_calls (docKind='router_classify') — для наблюдаемости ──
  try {
    await db.insert(llmCalls).values({
      sourceDocumentId: ctx.sourceDocumentId ?? null,
      providerId: row.id,
      promptId: null,
      docKind: 'router_classify',
      model: row.model,
      requestMessages: [
        {
          role: 'user',
          content: `[router classify: ${input.filename ?? 'no-name'} (${mime || 'unknown'}, ${input.buffer.length} bytes, pages=${images.length})]`,
        },
      ],
      requestSchema: ROUTER_CLASSIFY_SCHEMA as object,
      responseRaw: raw,
      responseParsed: null,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - startedAt,
      errorCode: error ? 'provider_error' : null,
      errorMessage: error,
    });
  } catch {
    /* лог не критичен для основного потока */
  }

  if (error) {
    return {
      detectedKind: 'unknown',
      confidence: 0,
      raw,
      error,
      providerId: row.id,
      providerKind: row.kind,
      pagesSent: images.length,
    };
  }
  const { kind, confidence } = parseRouterVisionRaw(raw);
  return {
    detectedKind: kind,
    confidence,
    raw,
    error: null,
    providerId: row.id,
    providerKind: row.kind,
    pagesSent: images.length,
  };
}

// Маленький Gemini-вызов под классификацию типа. Намеренно отдельный от
// callGemini в upd-vision.parser (та зашита под УПД-схему извлечения) — здесь
// своя крошечная responseSchema {kind, confidence}.
async function callGeminiClassify(args: {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  file: { buffer: Buffer; mimeType: string };
}): Promise<{ raw: string; promptTokens: number | null; completionTokens: number | null }> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: args.file.mimeType,
              data: args.file.buffer.toString('base64'),
            },
          },
          { text: ROUTER_CLASSIFY_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseSchema: ROUTER_CLASSIFY_SCHEMA,
    },
  };
  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/v1beta/models/${args.model}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ROUTER_CLASSIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini classify HTTP ${res.status}: ${text.slice(0, 300)}`);
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
