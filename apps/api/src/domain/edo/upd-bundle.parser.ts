// Multi-UPD bundle (Шаг 3) — БОЕВОЙ путь: один PDF-скан с несколькими УПД →
// один агрегированный UpdPdfParsed (docNumber «487, 488, 489, 490», merged
// items). Переиспользует prefilter (классификация + авто-поворот),
// segmentUpdPages (нарезка по upd_main), extractUpdFromPages (извлечение по
// группе) и aggregateUpdDocuments (свёртка) — всё уже покрыто Шагами 1–2.
//
// Безопасность v1:
//  - НЕ меняет одиночный flow parseUpdVision; вызывается ДО него и при любом
//    сомнении возвращает null → worker идёт обычным путём;
//  - bundle признаётся только когда сегментов ≥ 2 и ≥ 2 УПД реально извлеклись;
//  - НЕ требует миграции БД: агрегат сохраняется существующей секцией worker'а
//    через parsed.docNumber/parsed.items. Провенанс subdocs возвращается в
//    результате (для логов), но в БД пока НЕ персистится — это отдельная фаза
//    с аддитивной jsonb-миграцией.
//  - Работает на провайдере OpenRouter (image-путь, как PNG-страницы
//    prefilter'а). На прочих провайдерах возвращает null → обычный vision.

import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../../db/client.js';
import { llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { prefilterUpdPages } from './upd-page-prefilter.js';
import {
  MAX_PAGES_FOR_OPENROUTER,
  VisionBudgetExceededError,
  VisionTimeoutError,
} from './upd-vision.parser.js';
import { extractUpdFromPages } from './upd-vision-extract.js';
import {
  segmentUpdPages,
  aggregateUpdDocuments,
  type ParsedUpdSubdocument,
  type AggregatedSubdocMeta,
} from './upd-batch.parser.js';

export type UpdBundleResult = {
  parsed: UpdPdfParsed;
  llmProviderId: string;
  // сколько сегментов (УПД) нашли и сколько реально извлеклось
  segments: number;
  extracted: number;
  subdocs: AggregatedSubdocMeta[];
  reasons: string[];
};

// Быстрый счётчик страниц через pdfinfo (stdin). 0 — не удалось определить.
// Дешёвый гейт: одностраничный PDF не может быть пакетом из нескольких УПД,
// и мы выходим ДО рендера/классификации/обращения к БД — нулевая нагрузка
// на обычный одиночный сценарий (одностраничные сканы).
async function pdfPageCount(buffer: Buffer): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (n: number): void => {
      if (!done) {
        done = true;
        resolve(n);
      }
    };
    try {
      const proc = spawn('pdfinfo', ['-'], { timeout: 5000 });
      proc.stdout.on('data', (d) => {
        out += d.toString();
      });
      proc.on('error', () => finish(0));
      proc.on('close', () => {
        const m = out.match(/Pages:\s+(\d+)/);
        finish(m ? parseInt(m[1]!, 10) : 0);
      });
      proc.stdin.on('error', () => finish(0));
      proc.stdin.write(buffer);
      proc.stdin.end();
    } catch {
      finish(0);
    }
  });
}

// Тот же хвост формата ответа, что в production vision-flow (parseUpdVision):
// требуем ОДИН JSON-объект (не массив) на каждую группу.
function buildVisionPromptText(content: string): string {
  return (
    content +
    '\n\n# КРИТИЧНО: формат ответа\n' +
    'Верни ровно ОДИН JSON-объект на верхнем уровне ({"docNumber":..., "items":[...]}).\n' +
    'НЕ оборачивай его в массив. Ответ должен начинаться с символа `{`, а НЕ с `[`.'
  );
}

/**
 * Пытается распознать PDF как пакет из НЕСКОЛЬКИХ УПД и вернуть агрегат.
 * Возвращает null, если это НЕ bundle (один УПД, не тот провайдер, prefilter
 * не сработал и т.п.) — тогда worker идёт обычным одиночным путём.
 *
 * Бросает только VisionTimeoutError/VisionBudgetExceededError (fail-fast,
 * worker ловит их симметрично одиночному vision). Прочие сбои → null.
 */
export async function tryParseUpdBundle(
  buffer: Buffer,
  ctx: { sourceDocumentId: string | null },
): Promise<UpdBundleResult | null> {
  void ctx; // зарезервировано под будущее persist subdocs/llm_calls

  // ── дешёвый гейт: только многостраничные PDF могут быть пакетом УПД ──
  // Одностраничные (самый частый случай скана) выходят здесь же, до рендера
  // и обращения к БД — обычный одиночный flow не получает накладных расходов.
  const pageCount = await pdfPageCount(buffer);
  if (pageCount <= 1) return null;

  // ── провайдер: bundle работает на OpenRouter (image-путь) ──
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider || provider.kind !== 'openrouter') return null;

  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) return null;

  let apiKey: string;
  try {
    apiKey = decryptField(cred.apiKeyEncrypted, buildAad('llm_provider_credentials', cred.kind));
  } catch {
    return null;
  }

  // ── prefilter: классификация страниц + авто-поворот ──
  let prefilter;
  try {
    prefilter = await prefilterUpdPages(buffer, {
      apiBaseUrl: cred.apiBaseUrl,
      apiKey,
      model: provider.model,
      maxPages: MAX_PAGES_FOR_OPENROUTER,
    });
  } catch {
    // Ошибка рендера/классификации — не bundle-проблема: пусть обычный
    // vision попробует и при необходимости пометит parse_failed.
    return null;
  }

  // Классификации не было (одностраничный PDF) или классификатор не нашёл УПД
  // → это точно не пакет из нескольких УПД.
  if (!prefilter.classifyRan || prefilter.fellBack) return null;

  // ── сегментация по границам upd_main ──
  const segments = segmentUpdPages(prefilter.classification, prefilter.selectedPages);
  if (segments.length < 2) return null; // один УПД → обычный путь

  // ── карта «страница → PNG» (prefilter.pages параллелен selectedPages) ──
  const pngByPage = new Map<number, Buffer>();
  prefilter.selectedPages.forEach((p, i) => {
    const png = prefilter.pages[i];
    if (png) pngByPage.set(p, png);
  });

  const promptText = buildVisionPromptText((await loadActivePromptWithMeta('upd')).content);

  // ── извлечение каждого УПД по своей группе страниц ──
  const subdocs: ParsedUpdSubdocument[] = [];
  for (const seg of segments) {
    const segPages = seg.pages
      .map((p) => pngByPage.get(p))
      .filter((b): b is Buffer => b != null);
    if (segPages.length === 0) continue;
    try {
      const parsed = await extractUpdFromPages(segPages, {
        apiBaseUrl: cred.apiBaseUrl,
        apiKey,
        model: provider.model,
        temperature: Number(provider.temperature ?? 0.2),
        maxTokens: provider.maxTokens ?? 8192,
        promptText,
      });
      subdocs.push({ ...parsed, pages: seg.pages, segmentIndex: seg.segmentIndex });
    } catch (err) {
      // Таймаут/бюджет — fail-fast (как в одиночном vision).
      if (err instanceof VisionTimeoutError || err instanceof VisionBudgetExceededError) {
        throw err;
      }
      // Прочая ошибка одной группы — пропускаем её, агрегируем остальные.
      // (Если в итоге останется < 2 — вернём null ниже.)
    }
  }

  // Меньше двух реально извлечённых УПД — не считаем это надёжным bundle,
  // отдаём обычному пути (лучше один документ, чем половинчатый агрегат).
  if (subdocs.length < 2) return null;

  const agg = aggregateUpdDocuments(subdocs);
  const parsed: UpdPdfParsed = {
    docNumber: agg.docNumber,
    docDate: agg.docDate,
    totalSum: agg.totalSum,
    vatSum: agg.vatSum,
    itemsCount: agg.itemsCount,
    supplier: agg.supplier,
    recipient: agg.recipient,
    items: agg.items,
    confidence: agg.confidence,
  };

  return {
    parsed,
    llmProviderId: provider.id,
    segments: segments.length,
    extracted: subdocs.length,
    subdocs: agg.subdocs,
    reasons: agg.reasons,
  };
}
