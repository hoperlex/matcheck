/**
 * Сверка версий УПД-промпта на СЕГМЕНТНОМ пути — том самом, которым портал
 * разбирает комплекты фотографий.
 *
 * Зачем отдельный скрипт. upd-prompt-ab.ts гоняет корпус файлов, где «файл =
 * документ». Но основной сценарий сегодня другой: менеджер фотографирует пачку
 * бумаг, сборка режет страницы на логические УПД (`UPD_ASSEMBLY_V1`) и
 * распознаёт каждый сегмент отдельно через extractUpdSegment. Этот путь
 * корпусной сверкой не покрыт вовсе — а именно на нём документы и появляются.
 *
 * Что делает: повторяет шаги воркера по каталогу с фотографиями одного
 * комплекта —
 *   рендер/нормализация страниц → toClassifyThumb → classifyPages порциями
 *   → mergeClassificationChunks → planUpdSegments → extractUpdSegment,
 * прогоняет A/A/B (два прогона базовой версии + один новой) и сверяет
 * посегментно.
 *
 * Строгость сверки — та же, что у корпусной: снимок берётся общим snapshotOf
 * из prompt-ab-lib.ts (полные позиции, стороны, confidence со scale 3 и
 * контролем порогов 0.5 / 0.6). Сравнивать только номер, дату и число позиций
 * недостаточно: мимо такого фильтра проходят съехавшие наименования, цены,
 * НДС, объёмы и стороны документа. Меняться разрешено единственному полю —
 * consignee.
 *
 * Классификация страниц выполняется ОДИН раз и переиспользуется всеми тремя
 * прогонами: она зависит от отдельного промпта классификатора, а не от
 * УПД-промпта, и повторять её — платить трижды за один и тот же ответ.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/segment-prompt-ab.ts --dir /path/to/photos
 *   … --dir /path/to/photos --expected /path/to/expected.json
 *
 * Файл эталона (необязательный) — тот же формат, что expectedDocuments в
 * манифесте корпуса:
 *   [{ "docNumber": "1691", "consignee": { "name": "ООО «СУ-10»", "inn": null, "kpp": null } }]
 *
 * Стоит денег: классификация (1 вызов на каждые 15 страниц) + 3 × число
 * сегментов вызовов распознавания.
 *
 * НЕ меняет активный промпт и ничего не пишет в source_documents. Строки в
 * llm_calls появляются с source_document_id = NULL.
 *
 * Код возврата: 1 при любом блокере — скрипт годится для запуска в пайплайне,
 * а не только для чтения глазами.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { llmProviderCredentials, llmProviders, prompts } from '../src/db/schema.js';
import { buildAad, decryptField } from '../src/domain/auth/crypto.js';
import { imageToPng, renderPdf, toClassifyThumb } from '../src/domain/edo/page-render.js';
import { classifyPages, type PageClassification } from '../src/domain/edo/upd-page-prefilter.js';
import { mergeClassificationChunks, planUpdSegments } from '../src/domain/edo/upd-assembly.js';
import { extractUpdSegment } from '../src/domain/edo/upd-segment-extract.js';
import { MAX_PAGES_FOR_OPENROUTER } from '../src/domain/edo/upd-vision.parser.js';
import type { PromptOverride } from '../src/domain/prompts/registry.js';
import {
  compareUnit,
  evaluateGate,
  matchExpectation,
  type ExpectedDocument,
  type UnitComparison,
} from './prompt-ab-lib.js';

// Те же значения, что в бою: сверка обязана повторять прод, а не свою версию
// пайплайна. ASSEMBLY_CLASSIFY_CHUNK = 15 (worker.ts), предел страниц на
// сегмент берётся из MAX_PAGES_FOR_OPENROUTER — на нём же построен
// MAX_PAGES_FOR_OPENROUTER_SEGMENT воркера.
const ASSEMBLY_CLASSIFY_CHUNK = 15;
const MAX_PAGES_PER_SEGMENT = MAX_PAGES_FOR_OPENROUTER;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function loadPrompt(name: string): Promise<{ id: string; content: string }> {
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, 'upd'), eq(prompts.name, name)))
    .limit(1);
  if (!row) throw new Error(`Промпт «${name}» (doc_kind=upd) не найден в таблице prompts`);
  return row;
}

async function resolveOpenRouterCreds(): Promise<{
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}> {
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider || provider.kind !== 'openrouter') {
    throw new Error('провайдер по умолчанию не openrouter — сегментный путь недоступен');
  }
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) throw new Error('нет учётных данных провайдера');
  return {
    apiBaseUrl: cred.apiBaseUrl,
    apiKey: decryptField(cred.apiKeyEncrypted, buildAad('llm_provider_credentials', cred.kind)),
    model: provider.model,
  };
}

/** Страницы комплекта в том же виде, в каком их готовит buildAssemblyPages. */
async function buildPages(dir: string): Promise<{ full: Buffer; thumb: Buffer }[]> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => IMAGE_EXTS.includes(extname(n).toLowerCase()) || /\.pdf$/i.test(n))
    // Порядок съёмки = порядок файлов: сборка опирается на него так же.
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (names.length === 0) throw new Error(`в каталоге ${dir} нет изображений или PDF`);

  const pages: { full: Buffer; thumb: Buffer }[] = [];
  for (const name of names) {
    const buffer = await readFile(join(dir, name));
    const rendered = /\.pdf$/i.test(name) ? await renderPdf(buffer, {}) : [await imageToPng(buffer)];
    for (const full of rendered) {
      pages.push({ full, thumb: await toClassifyThumb(full) });
    }
  }
  return pages;
}

async function main(): Promise<void> {
  const dir = resolve(argValue('--dir') ?? '');
  if (!dir || !existsSync(dir)) {
    throw new Error('укажите каталог с фотографиями комплекта: --dir /path/to/photos');
  }
  const baseName = argValue('--base', 'default v8')!;
  const newName = argValue('--new', 'default v9')!;
  const expectedPath = argValue('--expected');

  const expectations: ExpectedDocument[] = expectedPath
    ? (JSON.parse(await readFile(resolve(expectedPath), 'utf8')) as ExpectedDocument[])
    : [];

  console.log(`[segment-ab] комплект: ${dir}`);
  const pages = await buildPages(dir);
  console.log(`[segment-ab] страниц: ${pages.length}`);

  const creds = await resolveOpenRouterCreds();

  // ── классификация: один раз на все прогоны ──
  const chunks: PageClassification[][] = [];
  const chunkSizes: number[] = [];
  for (let i = 0; i < pages.length; i += ASSEMBLY_CLASSIFY_CHUNK) {
    const slice = pages.slice(i, i + ASSEMBLY_CLASSIFY_CHUNK);
    const res = await classifyPages({ ...creds, thumbs: slice.map((p) => p.thumb) });
    chunks.push(res.classification);
    chunkSizes.push(slice.length);
  }
  const classification = mergeClassificationChunks(chunks, chunkSizes);
  const plan = planUpdSegments(classification, pages.length, MAX_PAGES_PER_SEGMENT);

  console.log(`[segment-ab] сегментов: ${plan.segments.length}, confident: ${plan.confident}`);
  for (const r of plan.reasons) console.log(`[segment-ab] причина: ${r}`);
  if (!plan.confident) {
    // Не блокер сверки промпта: нарезка зависит от классификатора, а не от
    // УПД-промпта. Но знать об этом надо — сегменты могут быть кривыми.
    console.log('[segment-ab] ВНИМАНИЕ: нарезке нельзя доверять, сравнение всё равно выполняется');
  }
  if (plan.segments.length === 0) throw new Error('сборка не выделила ни одного сегмента');

  const base = await loadPrompt(baseName);
  const fresh = await loadPrompt(newName);
  console.log(`[segment-ab] база: «${baseName}», новый: «${newName}», температура: 0`);

  const runSegment = async (
    segmentIndex: number,
    pageNumbers: number[],
    override: PromptOverride,
  ): Promise<UpdPdfParsed> => {
    const buffers = pageNumbers.map((p) => pages[p - 1]!.full);
    const r = await extractUpdSegment(buffers, {
      sourceDocumentId: null,
      bundleId: 'segment-ab',
      segmentIndex,
      promptOverride: override,
    });
    return r.parsed;
  };

  const comparisons: UnitComparison[] = [];
  const failures: { file: string; error: string }[] = [];

  for (const [index, segment] of plan.segments.entries()) {
    const label = `сегмент ${segment.segmentIndex} (страницы ${segment.pages.join(',')})`;
    process.stdout.write(`[segment-ab] ${label} … `);

    let a1: UpdPdfParsed;
    let a2: UpdPdfParsed;
    let b: UpdPdfParsed;
    try {
      a1 = await runSegment(segment.segmentIndex, segment.pages, { prompt: base, temperature: 0 });
      a2 = await runSegment(segment.segmentIndex, segment.pages, { prompt: base, temperature: 0 });
      b = await runSegment(segment.segmentIndex, segment.pages, { prompt: fresh, temperature: 0 });
    } catch (err) {
      console.log('ОШИБКА');
      failures.push({ file: label, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const comparison = compareUnit({
      label,
      a1,
      a2,
      b,
      // На сегментном пути regex-дозаполнения нет: страницы уходят картинками,
      // текста для fillPartiesFromText не существует. Всё, что вернулось, — от
      // модели.
      consigneeFromModel: true,
      expected: matchExpectation(b, index, expectations),
    });
    comparisons.push(comparison);

    console.log(
      (comparison.changed.length === 0 ? 'ок' : `РАСХОЖДЕНИЯ (${comparison.changed.length})`) +
        `, №${b.docNumber ?? '∅'}, позиций ${b.items.length}` +
        `, грузополучатель: ${b.consignee?.name ?? '∅'}`,
    );
  }

  console.log('\n──────── итог ────────');
  console.log(`Сегментов проверено: ${comparisons.length}`);

  if (failures.length > 0) {
    console.log(`\nНЕ РАЗОБРАЛИСЬ (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
  }

  const unstable = comparisons.filter((c) => c.unstable.length > 0);
  if (unstable.length > 0) {
    console.log('\nНЕСТАБИЛЬНЫЕ ПОЛЯ (разошлись между двумя прогонами базы):');
    for (const c of unstable) {
      const critical = c.unstableCritical.length > 0 ? ' ← КРИТИЧЕСКИЕ' : '';
      console.log(`  ${c.label}: ${c.unstable.join(', ')}${critical}`);
    }
  }

  const regressed = comparisons.filter((c) => c.changed.length > 0);
  if (regressed.length > 0) {
    console.log(`\nРЕГРЕСС: изменились стабильные поля (${regressed.length} сегментов):`);
    for (const c of regressed) console.log(`  ${c.label}: ${c.changed.join(', ')}`);
  }

  const shifted = comparisons.filter((c) => c.confidenceShift);
  if (shifted.length > 0) {
    console.log('\nCONFIDENCE ПЕРЕСЁК ПОРОГ (меняется маршрут документа):');
    for (const c of shifted) console.log(`  ${c.label}: ${c.confidenceShift}`);
  }

  const problems = comparisons.filter(
    (c) => c.expectation.status === 'mismatch' || c.expectation.status === 'filled_from_text',
  );
  if (problems.length > 0) {
    console.log(`\nГРУЗОПОЛУЧАТЕЛЬ — ПРОБЛЕМЫ (${problems.length}):`);
    for (const c of problems) {
      console.log(`  ${c.label}: ${'detail' in c.expectation ? c.expectation.detail : ''}`);
    }
  }
  if (expectations.length === 0) {
    console.log(
      '\nЭТАЛОН НЕ ЗАДАН (--expected): грузополучатель проверен не был,' +
        ' прогон доказывает только отсутствие регресса.',
    );
  }

  const blockers = evaluateGate({ checkedUnits: comparisons.length, failures, comparisons });
  if (blockers.length > 0) {
    console.log(`\nСЕГМЕНТНЫЙ ПРОГОН НЕ ПРОЙДЕН — ${blockers.join('; ')}.`);
    process.exitCode = 1;
  } else {
    console.log('\nСегментный прогон зелёный: изменился только грузополучатель.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$client.end({ timeout: 5 });
  });
