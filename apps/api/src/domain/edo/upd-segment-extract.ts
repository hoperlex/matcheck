// Извлечение одного логического УПД из страниц сегмента — боевой путь.
//
// upd-vision-extract.ts остаётся тонким proof-хелпером: он не ходит в БД за
// провайдером и промптом, не пишет в llm_calls и не повторяет попытку. Для
// разовой сверки этого хватало, для боя — нет: без записи вызова любой разбор
// сегмента становится неотлаживаемым, а один обрыв соединения (наблюдаемые
// 10-20% флакушности у vision-модели) терял бы документ целиком.
//
// Здесь всё то же, что у одиночного parseUpdVision: тот же провайдер и промпт
// из БД, тот же бюджет времени, та же классификация ошибок на transient и
// финальные, та же запись в llm_calls. Отличие ровно одно — на вход идут
// подготовленные PNG-страницы одного сегмента, а не файл целиком.

import { eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import { resolvePrompt, type PromptOverride } from '../prompts/registry.js';
import { extractUpdFromPages } from './upd-vision-extract.js';
import {
  MAX_PAGES_FOR_OPENROUTER,
  VisionBudgetExceededError,
  isTransientVisionError,
} from './upd-vision.parser.js';

// Те же значения, что у одиночного vision-пути: общий бюджет на сегмент,
// один повтор на transient-ошибку и минимальный запас, ниже которого начинать
// новую попытку бессмысленно.
const SEGMENT_TOTAL_TIMEOUT_MS = 240_000;
const SEGMENT_TRANSIENT_RETRIES = 1;
const SEGMENT_MIN_RETRY_BUDGET_MS = 30_000;

/**
 * Провайдер не поддерживает сегментное извлечение.
 *
 * Сегмент — это набор картинок, и путь построен на image-вызове OpenRouter.
 * На другом провайдере (Gemini через Google AI Studio) сборку выполнять
 * нечем, поэтому пакет откатывается на «файл = документ» целиком, а не
 * распознаётся наполовину.
 */
export class SegmentProviderUnsupportedError extends Error {
  constructor(reason: string) {
    super(`сегментное извлечение недоступно: ${reason}`);
    this.name = 'SegmentProviderUnsupportedError';
  }
}

export type SegmentExtractResult = {
  parsed: UpdPdfParsed;
  llmProviderId: string;
};

/**
 * Распознаёт один УПД по страницам его сегмента.
 *
 * Бросает:
 *   * SegmentProviderUnsupportedError — не тот провайдер / нет ключа (пакет
 *     уходит в legacy-откат);
 *   * VisionBudgetExceededError — исчерпан бюджет времени (worker ловит её
 *     симметрично одиночному пути, без BullMQ-retry);
 *   * прочие ошибки — как есть, после записи в llm_calls.
 */
export async function extractUpdSegment(
  pages: Buffer[],
  ctx: {
    // null — прогон вне разбора документа (офлайн-сверка версий промпта):
    // llm_calls.source_document_id nullable, ровно так же пишет parseUpdVision.
    sourceDocumentId: string | null;
    bundleId: string;
    segmentIndex: number;
    // Только для scripts/segment-prompt-ab.ts: подменяет активный промпт и
    // температуру. В бою не передаётся — тогда берётся промпт из БД, как и
    // раньше. Тот же механизм, что у parseUpdVision.
    promptOverride?: PromptOverride;
  },
): Promise<SegmentExtractResult> {
  if (pages.length === 0) throw new Error('сегмент без страниц');
  if (pages.length > MAX_PAGES_FOR_OPENROUTER) {
    // До сюда такой сегмент доходить не должен — его отбраковывает сборка.
    // Проверка оставлена как страховка: молча обрезать страницы нельзя, это
    // потерянные позиции в документе.
    throw new Error(
      `сегмент из ${pages.length} страниц превышает лимит ${MAX_PAGES_FOR_OPENROUTER}`,
    );
  }

  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider) throw new SegmentProviderUnsupportedError('провайдер по умолчанию не задан');
  if (provider.kind !== 'openrouter') {
    throw new SegmentProviderUnsupportedError(`провайдер ${provider.kind} не image-путь`);
  }

  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) throw new SegmentProviderUnsupportedError('нет учётных данных провайдера');

  let apiKey: string;
  try {
    apiKey = decryptField(cred.apiKeyEncrypted, buildAad('llm_provider_credentials', cred.kind));
  } catch {
    throw new SegmentProviderUnsupportedError('не удалось расшифровать ключ провайдера');
  }

  const promptMeta = await resolvePrompt('upd', ctx.promptOverride);
  // Тот же хвост, что у bundle-пути: модель обязана вернуть ОДИН объект.
  // Сегмент — это один УПД, и массив на верхнем уровне ломает валидацию.
  const promptText =
    promptMeta.content +
    '\n\n# КРИТИЧНО: формат ответа\n' +
    'Верни ровно ОДИН JSON-объект на верхнем уровне ({"docNumber":..., "items":[...]}).\n' +
    'НЕ оборачивай его в массив. Ответ должен начинаться с символа `{`, а НЕ с `[`.';

  const runOneAttempt = async (attempt: number): Promise<SegmentExtractResult> => {
    const startedAt = Date.now();
    let parsed: UpdPdfParsed | null = null;
    let payloadFit: { quality: number; scale: number; bytes: number } | undefined;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    try {
      const extracted = await extractUpdFromPages(pages, {
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: provider.model,
        temperature: ctx.promptOverride?.temperature ?? Number(provider.temperature ?? 0.2),
        maxTokens: provider.maxTokens ?? 8192,
        promptText,
      });
      parsed = extracted.parsed;
      payloadFit = extracted.payloadFit;
      return { parsed, llmProviderId: provider.id };
    } catch (err) {
      errorCode = 'segment_extract_failed';
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Сами изображения в лог не кладём (мегабайты base64) — только адрес
      // сегмента и номер попытки: этого достаточно, чтобы связать вызов с
      // манифестом и понять, был ли повтор.
      try {
        await db.insert(llmCalls).values({
          sourceDocumentId: ctx.sourceDocumentId,
          providerId: provider.id,
          promptId: promptMeta.id,
          docKind: 'upd',
          model: provider.model,
          requestMessages: [
            {
              role: 'user',
              content:
                `[segment bundle=${ctx.bundleId} index=${ctx.segmentIndex} ` +
                `pages=${pages.length} attempt=${attempt}` +
                // Подгонка под потолок размера — просадка качества, и она
                // должна быть видна в админке: иначе «модель вдруг стала хуже
                // читать цифры» не с чем связать.
                (payloadFit
                  ? ` fit=jpeg:q${payloadFit.quality}:x${payloadFit.scale}:${payloadFit.bytes}b`
                  : '') +
                `]\n${promptText.slice(0, 4000)}`,
            },
          ],
          responseParsed: parsed as unknown as object | null,
          latencyMs: Date.now() - startedAt,
          errorCode,
          errorMessage,
        });
      } catch {
        /* лог вызова не должен ронять разбор */
      }
    }
  };

  const overallStartMs = Date.now();
  const deadlineMs = overallStartMs + SEGMENT_TOTAL_TIMEOUT_MS;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 1 + SEGMENT_TRANSIENT_RETRIES; attempt++) {
    if (attempt > 1 && deadlineMs - Date.now() < SEGMENT_MIN_RETRY_BUDGET_MS) {
      throw new VisionBudgetExceededError(Date.now() - overallStartMs);
    }
    try {
      return await runOneAttempt(attempt);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastErr = e;
      if (attempt < 1 + SEGMENT_TRANSIENT_RETRIES && isTransientVisionError(e)) continue;
      throw e;
    }
  }
  throw lastErr ?? new Error('сегмент: не удалось распознать');
}
