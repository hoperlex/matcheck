// Лёгкий vision-классификатор ТИПА документа по изображению. Нужен для файлов,
// тип которых НЕ определён детерминированно (фото/скан/битый PDF → в
// classifyFile это detectedKind='unknown', needsVision=true) и у которых нет
// маркера в имени. По одной странице/картинке модель решает: УПД / накладная
// (ТН/ОС-2) / М-15 / unknown — и роутер направляет файл в нужную форму.
//
// Это НЕ парсинг: один дешёвый запрос (1 изображение, короткий промпт, ≤200
// токенов). Ошибка/таймаут/низкая уверенность → возвращаем null, и роутер
// оставляет прежнее поведение (УПД-vision). Так уже работающее распознавание
// не затрагивается: сюда попадают только «неопознанные» фото/сканы.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { llmProviders, llmProviderCredentials, llmCalls } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import {
  callGemini,
  callOpenRouter,
  stripJsonFences,
  pdfToPngsViaPoppler,
} from './upd-vision.parser.js';

export type ImageDocKind =
  | 'upd'
  | 'transport_waybill'
  | 'os2_transfer'
  | 'm15'
  | 'supplementary'
  | 'unknown';

const CLASSIFY_PROMPT = `Определи ТИП документа на изображении и ответь СТРОГО одним JSON-объектом: {"kind": "<тип>", "confidence": <0..1>}.

Возможные значения kind:
- "upd" — счёт-фактура / универсальный передаточный документ (УПД) по форме ПП №1137 (заголовок «Счёт-фактура №…», графы 1–11).
- "transport_waybill" — транспортная накладная (ТН, форма 2116) ИЛИ накладная на внутреннее перемещение основных средств (форма ОС-2).
- "m15" — накладная на отпуск материалов на сторону (типовая форма М-15, заголовок «на отпуск материалов»).
- "supplementary" — документ о качестве или соответствии: сертификат соответствия, сертификат качества, паспорт качества, декларация о соответствии, протокол испытаний. Реквизиты поставки из него не берут.
- "unknown" — не удаётся уверенно определить, либо это другой документ (спецификация, акт и т.п.).

Ориентируйся на ЗАГОЛОВОК и структуру таблицы. confidence — твоя уверенность от 0 до 1. Отвечай ТОЛЬКО JSON, без пояснений.`;

const MAX_TOKENS = 200;
const TEMPERATURE = 0;

export function normalizeKind(k: string | undefined): ImageDocKind {
  switch ((k ?? '').trim().toLowerCase()) {
    case 'upd':
      return 'upd';
    case 'transport_waybill':
    case 'waybill':
    case 'tn':
    case 'тн':
      return 'transport_waybill';
    case 'os2_transfer':
    case 'os2':
    case 'ос-2':
    case 'ос2':
      return 'os2_transfer';
    case 'm15':
    case 'м-15':
    case 'м15':
      return 'm15';
    case 'supplementary':
    case 'certificate':
    case 'сертификат':
    case 'паспорт качества':
      return 'supplementary';
    default:
      return 'unknown';
  }
}

/**
 * Классифицирует тип документа по изображению. Возвращает null при любой
 * проблеме (нет провайдера/ключа, ошибка рендера PDF, ошибка/таймаут vision,
 * невалидный JSON) — вызывающая сторона трактует null как «оставить прежнее
 * поведение». Никогда не бросает — безопасно для router-цикла.
 */
export async function classifyImageKind(
  buffer: Buffer,
  mimeType: string,
  ctx: {
    sourceDocumentId: string | null;
    /**
     * Метка вызова для журнала llm_calls. Без неё запись остаётся ровно такой,
     * какой была всегда («[router image classify]»), — воркер документов зовёт
     * классификатор без метки, и его журнал не должен меняться.
     *
     * Фото-путь метку передаёт: source_document_id у него нет вовсе, и разобрать
     * жалобу «на этом фото не то количество» иначе нечем.
     */
    label?: string | null;
    /** Таймаут вызова. По умолчанию — общий VISION_ATTEMPT_TIMEOUT_MS (180 с). */
    timeoutMs?: number;
  } = { sourceDocumentId: null },
): Promise<{ kind: ImageDocKind; confidence: number } | null> {
  // Реквизиты для журнала: заполняются по ходу и нужны ветке ошибки.
  let providerId: string | null = null;
  let model: string | null = null;
  let startMs = Date.now();
  try {
    const mime = (mimeType || '').toLowerCase();

    const [row] = await db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.isDefault, true))
      .limit(1);
    if (!row || (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter')) return null;
    providerId = row.id;
    model = row.model;

    const [cred] = await db
      .select()
      .from(llmProviderCredentials)
      .where(eq(llmProviderCredentials.kind, row.kind))
      .limit(1);
    if (!cred) return null;
    const apiKey = decryptField(cred.apiKeyEncrypted, buildAad('llm_provider_credentials', cred.kind));

    // Одна картинка: для PDF — первая страница в PNG; для изображения — как есть.
    let file: { buffer: Buffer; mimeType: string };
    if (mime === 'application/pdf' || (!mime.startsWith('image/') && !mime)) {
      const pngs = await pdfToPngsViaPoppler(buffer, 1);
      if (!pngs.length || !pngs[0]) return null;
      file = { buffer: pngs[0], mimeType: 'image/png' };
    } else {
      file = { buffer, mimeType: mime || 'image/jpeg' };
    }

    startMs = Date.now();
    let raw = '';
    if (row.kind === 'google_ai_studio') {
      const r = await callGemini({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
        promptText: CLASSIFY_PROMPT,
        file,
        timeoutMs: ctx.timeoutMs,
      });
      raw = r.raw;
    } else {
      const r = await callOpenRouter({
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: row.model,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
        promptText: CLASSIFY_PROMPT,
        files: [file],
        timeoutMs: ctx.timeoutMs,
      });
      raw = r.raw;
    }
    const latencyMs = Date.now() - startMs;

    if (!raw) {
      await logFailure(ctx, providerId, model, latencyMs, 'provider_error', 'пустой ответ модели');
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch (err) {
      await logFailure(ctx, providerId, model, latencyMs, 'json_failed', errText(err), raw);
      return null;
    }
    if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
    const p = (parsed ?? {}) as { kind?: string; confidence?: number };
    const kind = normalizeKind(p.kind);
    const confidence = typeof p.confidence === 'number' ? p.confidence : 0;

    // Лог в журнал распознавания (docKind='router_classify') — best-effort.
    try {
      await db.insert(llmCalls).values({
        sourceDocumentId: ctx.sourceDocumentId,
        providerId: row.id,
        promptId: null,
        docKind: 'router_classify',
        model: row.model,
        requestMessages: [{ role: 'user', content: requestLabel(ctx.label) }],
        requestSchema: null,
        responseRaw: raw,
        responseParsed: { kind, confidence } as object,
        promptTokens: null,
        completionTokens: null,
        latencyMs,
        errorCode: null,
        errorMessage: null,
      });
    } catch {
      /* лог не критичен для основного потока */
    }

    return { kind, confidence };
  } catch (err) {
    // Любая ошибка (рендер PDF, vision-таймаут, сеть, HTTP 429) — не ломаем
    // router-цикл, но и не теряем: см. logFailure.
    await logFailure(ctx, providerId, model, Date.now() - startMs, 'provider_error', errText(err));
    return null;
  }
}

/**
 * Строка запроса в журнале.
 *
 * Без метки — ровно та, что была до появления фото-пути: воркер документов
 * зовёт классификатор без неё, и его записи обязаны остаться прежними.
 */
function requestLabel(label: string | null | undefined): string {
  return label ? `[router image classify: ${label}]` : '[router image classify]';
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Запись о неудачной классификации — ТОЛЬКО для вызовов с меткой.
 *
 * Зачем вообще. Классификатор глушит любую ошибку в `null`, и до сих пор при
 * сбое в журнале не оставалось ничего. Для роутера документов это осознанно:
 * его вердикт лишь выбирает форму, а сам разбор всё равно оставит свою запись.
 * Для фото-пути наоборот — классификация делается на КАЖДОЕ фото и стала самым
 * массовым вызовом к провайдеру: если он начнёт отвечать 429, увидеть это
 * можно только здесь.
 *
 * Условие по метке, а не по флагу: так журнал воркера не меняется ни на строку,
 * что и требовалось от выкладки.
 */
async function logFailure(
  ctx: { sourceDocumentId: string | null; label?: string | null },
  providerId: string | null,
  model: string | null,
  latencyMs: number,
  errorCode: string,
  errorMessage: string,
  raw?: string,
): Promise<void> {
  if (!ctx.label) return;
  try {
    await db.insert(llmCalls).values({
      sourceDocumentId: ctx.sourceDocumentId,
      providerId,
      promptId: null,
      docKind: 'router_classify',
      model,
      requestMessages: [{ role: 'user', content: requestLabel(ctx.label) }],
      requestSchema: null,
      responseRaw: raw ?? null,
      responseParsed: null,
      promptTokens: null,
      completionTokens: null,
      // Колонка NOT NULL: пишем фактическое время до отказа, оно же показывает
      // таймаут (45 000 у фото-пути) отдельно от быстрых сетевых обрывов.
      latencyMs: Math.max(0, Math.round(latencyMs)),
      errorCode,
      errorMessage,
    });
  } catch {
    /* журнал не должен ронять распознавание */
  }
}
