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

export type ImageDocKind = 'upd' | 'transport_waybill' | 'os2_transfer' | 'm15' | 'unknown';

const CLASSIFY_PROMPT = `Определи ТИП документа на изображении и ответь СТРОГО одним JSON-объектом: {"kind": "<тип>", "confidence": <0..1>}.

Возможные значения kind:
- "upd" — счёт-фактура / универсальный передаточный документ (УПД) по форме ПП №1137 (заголовок «Счёт-фактура №…», графы 1–11).
- "transport_waybill" — транспортная накладная (ТН, форма 2116) ИЛИ накладная на внутреннее перемещение основных средств (форма ОС-2).
- "m15" — накладная на отпуск материалов на сторону (типовая форма М-15, заголовок «на отпуск материалов»).
- "unknown" — не удаётся уверенно определить, либо это другой документ (сертификат, спецификация, акт и т.п.).

Ориентируйся на ЗАГОЛОВОК и структуру таблицы. confidence — твоя уверенность от 0 до 1. Отвечай ТОЛЬКО JSON, без пояснений.`;

const MAX_TOKENS = 200;
const TEMPERATURE = 0;

function normalizeKind(k: string | undefined): ImageDocKind {
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
  ctx: { sourceDocumentId: string | null } = { sourceDocumentId: null },
): Promise<{ kind: ImageDocKind; confidence: number } | null> {
  try {
    const mime = (mimeType || '').toLowerCase();

    const [row] = await db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.isDefault, true))
      .limit(1);
    if (!row || (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter')) return null;

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

    const startMs = Date.now();
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
      });
      raw = r.raw;
    }
    const latencyMs = Date.now() - startMs;

    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch {
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
        requestMessages: [{ role: 'user', content: '[router image classify]' }],
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
  } catch {
    // Любая ошибка (рендер PDF, vision-таймаут, сеть) — не ломаем router-цикл.
    return null;
  }
}
