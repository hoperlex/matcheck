// ─────────────────────────────────────────────────────────────────────────
// DEBUG-ONLY скрипт (НЕ часть production flow).
//
// Прогоняет многостраничный УПД-скан через:
//   prefilterUpdPages  → классификация + авто-поворот страниц
//   segmentUpdPages    → нарезка на УПД-документы по границам upd_main
//   [TODO]             → extract каждой группы Vision'ом + aggregateUpdDocuments
//
// Запуск (в окружении API, где есть БД и LLM-креды):
//   pnpm --filter @matcheck/api exec tsx scripts/debug-multi-upd-pdf.ts [путь.pdf]
// По умолчанию путь = docs/debug-upd/сканирование0202.pdf
//
// Только ЧИТАЕТ из БД (default LLM-провайдер + ключ). Ничего не пишет:
// ни source_documents, ни llm_calls. Цель — глазами убедиться, что
// 4-страничный скан режется на 4 УПД и страницы не смешиваются.
// ─────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { llmProviders, llmProviderCredentials } from '../src/db/schema.js';
import { buildAad, decryptField } from '../src/domain/auth/crypto.js';
import { prefilterUpdPages } from '../src/domain/edo/upd-page-prefilter.js';
import { MAX_PAGES_FOR_OPENROUTER } from '../src/domain/edo/upd-vision.parser.js';
import { extractUpdFromPages } from '../src/domain/edo/upd-vision-extract.js';
import {
  segmentUpdPages,
  aggregateUpdDocuments,
  type ParsedUpdSubdocument,
} from '../src/domain/edo/upd-batch.parser.js';
import { loadActivePromptWithMeta } from '../src/domain/prompts/registry.js';

const DEFAULT_PDF = 'docs/debug-upd/сканирование0202.pdf';
// Корень репозитория: apps/api/scripts → ../../.. (скрипт запускается из
// apps/api, поэтому дефолтный путь привязываем к расположению файла, а не cwd).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  const argPath = process.argv[2];
  // Явный аргумент — относительно cwd; дефолт — относительно корня репозитория.
  const pdfPath = argPath
    ? resolve(process.cwd(), argPath)
    : resolve(REPO_ROOT, DEFAULT_PDF);
  console.log(`\n=== debug multi-UPD PDF ===\nфайл: ${pdfPath}\n`);

  const pdfBuffer = await readFile(pdfPath);
  console.log(`размер: ${pdfBuffer.length} байт`);

  // ── default LLM-провайдер + ключ (read-only) ──
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider) {
    console.error('Нет default LLM-провайдера — prefilter без классификации деградирует к первым страницам.');
    process.exit(1);
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) {
    console.error(`Нет ключа провайдера ${provider.kind}.`);
    process.exit(1);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  console.log(`провайдер: ${provider.kind} / модель: ${provider.model}\n`);

  // ── prefilter: классификация + поворот ──
  const prefilter = await prefilterUpdPages(pdfBuffer, {
    apiBaseUrl: cred.apiBaseUrl,
    apiKey,
    model: provider.model,
    maxPages: MAX_PAGES_FOR_OPENROUTER,
  });

  console.log('── prefilter ──');
  console.log(`всего страниц отрендерено: ${prefilter.totalPages}`);
  console.log(`классификация LLM выполнялась: ${prefilter.classifyRan}`);
  console.log(`деградация (УПД не найден классиф.): ${prefilter.fellBack}`);
  console.log(`/Rotate из PDF по страницам: [${prefilter.perPageRotateFlag.join(', ')}]`);
  console.log('классификация по страницам:');
  for (const c of prefilter.classification) {
    console.log(`  стр.${c.page}: type=${c.type} use=${c.use}`);
  }
  console.log(`выбранные страницы (selectedPages): [${prefilter.selectedPages.join(', ')}]`);
  console.log(`применённые повороты (deg): [${prefilter.rotations.join(', ')}]`);

  // ── segment: нарезка на УПД ──
  const segments = segmentUpdPages(prefilter.classification, prefilter.selectedPages);
  console.log(`\n── segments (УПД-документы): ${segments.length} ──`);
  for (const s of segments) {
    console.log(
      `  #${s.segmentIndex}: страницы [${s.pages.join(', ')}] · ${s.confidence}` +
        (s.reasons.length ? ` · ${s.reasons.join('; ')}` : ''),
    );
  }

  // ── extract per segment + aggregate (Шаг 2) ──
  // extractUpdFromPages — OpenRouter image-путь. Для google_ai_studio
  // (отдельный API-формат) пропускаем: helper рассчитан на OpenRouter,
  // как и сами PNG-страницы из prefilter.
  if (provider.kind !== 'openrouter') {
    console.log(
      `\n[skip extract] default провайдер = ${provider.kind}; extract-per-segment ` +
        'реализован для OpenRouter image-пути. Сегменты выше уже показаны.',
    );
    console.log('\n=== готово ===\n');
    return;
  }

  // Карта «номер страницы → PNG» (prefilter.pages параллелен selectedPages).
  const pngByPage = new Map<number, Buffer>();
  prefilter.selectedPages.forEach((p, i) => {
    const png = prefilter.pages[i];
    if (png) pngByPage.set(p, png);
  });

  // Тот же промпт, что в production vision-flow: active 'upd' + хвост про
  // один JSON-объект (зеркало parseUpdVision; дублируется здесь, т.к. debug).
  const promptMeta = await loadActivePromptWithMeta('upd');
  const promptText =
    promptMeta.content +
    '\n\n# КРИТИЧНО: формат ответа\n' +
    'Верни ровно ОДИН JSON-объект на верхнем уровне ({"docNumber":..., "items":[...]}).\n' +
    'НЕ оборачивай его в массив. Ответ должен начинаться с символа `{`, а НЕ с `[`.';

  console.log('\n── extract per segment ──');
  const subdocs: ParsedUpdSubdocument[] = [];
  for (const seg of segments) {
    const segPages = seg.pages
      .map((p) => pngByPage.get(p))
      .filter((b): b is Buffer => b != null);
    if (segPages.length === 0) {
      console.log(`  #${seg.segmentIndex}: нет PNG для страниц [${seg.pages.join(', ')}] — пропуск`);
      continue;
    }
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
      console.log(
        `  #${seg.segmentIndex} [стр. ${seg.pages.join(', ')}]: № ${parsed.docNumber ?? '—'} · ` +
          `дата ${parsed.docDate ?? '—'} · сумма ${parsed.totalSum ?? '—'} · НДС ${parsed.vatSum ?? '—'} · ` +
          `позиций ${parsed.items.length} · conf ${parsed.confidence}`,
      );
    } catch (err) {
      console.log(`  #${seg.segmentIndex} [стр. ${seg.pages.join(', ')}]: extract упал — ${(err as Error).message}`);
    }
  }

  // ── aggregate ──
  if (subdocs.length === 0) {
    console.log('\n[нет распознанных субдокументов — агрегировать нечего]');
    console.log('\n=== готово ===\n');
    return;
  }
  const agg = aggregateUpdDocuments(subdocs);
  console.log('\n── aggregate (одна будущая строка в «Документы») ──');
  console.log(`  docNumber : ${agg.docNumber}`);
  console.log(`  docDate   : ${agg.docDate}`);
  console.log(`  totalSum  : ${agg.totalSum}`);
  console.log(`  vatSum    : ${agg.vatSum}`);
  console.log(`  itemsCount: ${agg.itemsCount}`);
  if (agg.reasons.length) console.log(`  reasons   : ${agg.reasons.join('; ')}`);
  console.log('  subdocs   :');
  for (const s of agg.subdocs) {
    console.log(
      `    № ${s.docNumber ?? '—'} · стр.[${s.pages.join(',')}] · сумма ${s.totalSum ?? '—'} · ` +
        `НДС ${s.vatSum ?? '—'} · позиции lineNos [${s.itemLineNos.join(',')}]`,
    );
  }

  console.log('\n=== готово ===\n');
}

main()
  .then(async () => {
    await sql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('debug-multi-upd-pdf упал:', err);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(1);
  });
