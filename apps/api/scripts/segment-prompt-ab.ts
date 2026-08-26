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
 * ЧАСТЯМИ. Комплект из пятнадцати УПД — это сорок пять вызовов распознавания
 * подряд, поэтому его гоняют окнами по сегментам:
 *   … --dir ./set --classify-cache /tmp/set.classify.json --plan
 *   … --dir ./set --classify-cache /tmp/set.classify.json \
 *       --base "default v13" --new "default v15" \
 *       --offset 0 --limit 3 --delay 2000 --out /tmp/seg-00.json
 *   … --offset 3 --limit 3 --delay 2000 --out /tmp/seg-03.json
 * Свод частей — тем же агрегатором, что и у корпусной сверки:
 *   pnpm --filter @matcheck/api exec tsx scripts/prompt-ab-merge.ts /tmp/seg-*.json
 *
 * --classify-cache при прогоне частями ОБЯЗАТЕЛЕН. Нарезку делает модель, и
 * без кеша каждое окно получило бы свою: «сегмент 3» во втором окне оказался бы
 * другим документом, чем в первом, а сводное покрытие — ложным. Кеш привязан к
 * отпечатку страниц: сменился комплект — скрипт откажется его брать.
 *
 * --plan печатает нарезку и число предстоящих вызовов, НЕ запуская
 * распознавание: сколько будет стоить прогон, видно до его начала.
 *
 * Флаги окна и паузы те же, что у upd-prompt-ab.ts: --offset, --limit, --delay
 * (пауза перед каждым вызовом модели), --out (воспроизводимый отчёт с хешами
 * версий промпта и фактической моделью каждого вызова).
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
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { and, eq, gte, isNull } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { llmCalls, llmProviderCredentials, llmProviders, prompts } from '../src/db/schema.js';
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
  mixedModelPrompts,
  parseIntArg,
  windowOf,
  writeReportSafely,
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

/** Целочисленный аргумент со строгой проверкой (правило — в prompt-ab-lib). */
function argNumber(flag: string, fallback: number): number {
  return parseIntArg(argValue(flag), flag, fallback);
}

/**
 * Пауза ПЕРЕД КАЖДЫМ вызовом модели — и классификации, и распознавания.
 *
 * На сегментном пути запросы идут особенно плотно: комплект из пятнадцати
 * УПД даёт сорок пять вызовов распознавания подряд, без единого разрыва.
 */
let callDelayMs = 0;
let lastCallStartedAt = 0;

async function throttle(): Promise<void> {
  if (callDelayMs <= 0) return;
  const wait = lastCallStartedAt + callDelayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallStartedAt = Date.now();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitRevision(): { sha: string | null; dirty: boolean | null } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

type CallRecord = {
  id: string;
  createdAt: string;
  promptId: string | null;
  providerId: string | null;
  providerName: string | null;
  docKind: string | null;
  model: string | null;
  errorCode: string | null;
  latencyMs: number | null;
};

/** Фактические вызовы прогона — см. пояснение в upd-prompt-ab.ts. */
async function collectCalls(since: Date): Promise<CallRecord[]> {
  const rows = await db
    .select({
      id: llmCalls.id,
      createdAt: llmCalls.createdAt,
      promptId: llmCalls.promptId,
      providerId: llmCalls.providerId,
      docKind: llmCalls.docKind,
      model: llmCalls.model,
      errorCode: llmCalls.errorCode,
      latencyMs: llmCalls.latencyMs,
      providerName: llmProviders.name,
    })
    .from(llmCalls)
    .leftJoin(llmProviders, eq(llmProviders.id, llmCalls.providerId))
    .where(and(isNull(llmCalls.sourceDocumentId), gte(llmCalls.createdAt, since)))
    .orderBy(llmCalls.createdAt);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    promptId: r.promptId,
    providerId: r.providerId,
    providerName: r.providerName,
    docKind: r.docKind,
    model: r.model,
    errorCode: r.errorCode,
    latencyMs: r.latencyMs,
  }));
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
  const offset = argNumber('--offset', 0);
  const limit = argNumber('--limit', Number.MAX_SAFE_INTEGER);
  callDelayMs = argNumber('--delay', 0);
  const outPath = argValue('--out');
  const cachePath = argValue('--classify-cache');
  const planOnly = process.argv.includes('--plan');
  const startedAt = new Date();

  const expectedRaw = expectedPath ? await readFile(resolve(expectedPath), 'utf8') : null;
  const expectations: ExpectedDocument[] = expectedRaw
    ? (JSON.parse(expectedRaw) as ExpectedDocument[])
    : [];

  console.log(`[segment-ab] комплект: ${dir}`);
  const pages = await buildPages(dir);
  console.log(`[segment-ab] страниц: ${pages.length}`);
  // Отпечаток комплекта: к нему привязан кеш нарезки. Добавили или пересняли
  // страницу — прежняя нарезка к делу больше не относится.
  const pagesHash = sha256(Buffer.concat(pages.map((p) => p.full)));

  const creds = await resolveOpenRouterCreds();

  // ── классификация: один раз на все прогоны ──
  //
  // При прогоне ЧАСТЯМИ её результат обязан быть один и тот же для всех окон.
  // Классификатор — та же модель, ответ у неё не строго детерминирован, и без
  // кеша окна получили бы РАЗНУЮ нарезку: «сегмент 3» во втором окне оказался
  // бы другим документом, а сводное покрытие — ложным. Плюс экономия: иначе
  // каждое окно заново платит за классификацию всех страниц комплекта.
  let classification: PageClassification[] | null = null;
  const cacheFile = cachePath ? resolve(cachePath) : null;
  if (cacheFile && existsSync(cacheFile)) {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as {
      pagesHash: string;
      classification: PageClassification[];
    };
    if (cached.pagesHash !== pagesHash) {
      throw new Error(
        `кеш классификации ${cacheFile} снят с другого комплекта страниц. ` +
          'Удалите файл, если комплект изменился намеренно.',
      );
    }
    classification = cached.classification;
    console.log(`[segment-ab] нарезка взята из кеша: ${cacheFile} (вызовов классификации: 0)`);
  }
  if (!classification) {
    const chunks: PageClassification[][] = [];
    const chunkSizes: number[] = [];
    for (let i = 0; i < pages.length; i += ASSEMBLY_CLASSIFY_CHUNK) {
      const slice = pages.slice(i, i + ASSEMBLY_CLASSIFY_CHUNK);
      await throttle();
      const res = await classifyPages({ ...creds, thumbs: slice.map((p) => p.thumb) });
      chunks.push(res.classification);
      chunkSizes.push(slice.length);
    }
    classification = mergeClassificationChunks(chunks, chunkSizes);
    if (cacheFile) {
      await writeFile(cacheFile, `${JSON.stringify({ pagesHash, classification }, null, 2)}\n`, 'utf8');
      console.log(`[segment-ab] нарезка сохранена в кеш: ${cacheFile}`);
    } else if (offset > 0 || Number.isSafeInteger(limit)) {
      // Частичный прогон без кеша — та самая ловушка, ради которой кеш и заведён.
      console.log(
        '[segment-ab] ВНИМАНИЕ: прогон частями БЕЗ --classify-cache. Нарезка в разных ' +
          'окнах может разойтись, и свод окажется недостоверным.',
      );
    }
  }
  const plan = planUpdSegments(classification, pages.length, MAX_PAGES_PER_SEGMENT);

  console.log(`[segment-ab] сегментов: ${plan.segments.length}, confident: ${plan.confident}`);
  const allSegments = plan.segments;
  const work = windowOf(allSegments, offset, limit);
  if (work.length < allSegments.length) {
    const to = offset + work.length;
    console.log(`[segment-ab] окно: сегменты ${offset + 1}..${to} из ${allSegments.length}`);
    if (to < allSegments.length) console.log(`[segment-ab] следующая часть: --offset ${to}`);
  }
  if (callDelayMs > 0) console.log(`[segment-ab] пауза между вызовами модели: ${callDelayMs} мс`);
  // Три прогона на сегмент: два базовых (A/A) и один новой версии.
  console.log(`[segment-ab] вызовов распознавания в этом окне: ${work.length * 3}`);
  if (planOnly) {
    // Классификация к этому моменту уже выполнена (или взята из кеша) — без
    // неё нарезка неизвестна, а значит неизвестна и цена прогона. Распознавание
    // не запускается: именно оно составляет почти всю стоимость.
    console.log(
      '[segment-ab] --plan: распознавание НЕ запускалось. ' +
        (cacheFile
          ? 'Нарезка в кеше — повторный --plan вызовов модели не сделает.'
          : 'Классификация выполнена без кеша; добавьте --classify-cache, чтобы не платить за неё снова.'),
    );
    return;
  }
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
  ): Promise<{ parsed: UpdPdfParsed; providerId: string | null }> => {
    const buffers = pageNumbers.map((p) => pages[p - 1]!.full);
    await throttle();
    const r = await extractUpdSegment(buffers, {
      sourceDocumentId: null,
      bundleId: 'segment-ab',
      segmentIndex,
      promptOverride: override,
    });
    // Провайдер запоминается по каждому сегменту: сравнивать версии, читанные
    // разными моделями, бессмысленно.
    return { parsed: r.parsed, providerId: r.llmProviderId ?? null };
  };

  const comparisons: UnitComparison[] = [];
  const failures: { file: string; error: string }[] = [];
  /** Сегменты, которые база и новая версия читали разными моделями. */
  const providerMismatch: string[] = [];

  for (const [windowIndex, segment] of work.entries()) {
    // Эталон ищется по номеру документа, а при его отсутствии — по позиции
    // среди ВСЕХ сегментов комплекта, а не внутри окна: иначе второе окно
    // сверялось бы с эталоном первого.
    const index = offset + windowIndex;
    const label = `сегмент ${segment.segmentIndex} (страницы ${segment.pages.join(',')})`;
    process.stdout.write(`[segment-ab] ${label} … `);

    let a1: { parsed: UpdPdfParsed; providerId: string | null };
    let a2: { parsed: UpdPdfParsed; providerId: string | null };
    let b: { parsed: UpdPdfParsed; providerId: string | null };
    try {
      a1 = await runSegment(segment.segmentIndex, segment.pages, { prompt: base, temperature: 0 });
      a2 = await runSegment(segment.segmentIndex, segment.pages, { prompt: base, temperature: 0 });
      b = await runSegment(segment.segmentIndex, segment.pages, { prompt: fresh, temperature: 0 });
    } catch (err) {
      console.log('ОШИБКА');
      failures.push({ file: label, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    if (new Set([a1.providerId, a2.providerId, b.providerId]).size > 1) {
      providerMismatch.push(label);
    }

    const comparison = compareUnit({
      label,
      a1: a1.parsed,
      a2: a2.parsed,
      b: b.parsed,
      // На сегментном пути regex-дозаполнения нет: страницы уходят картинками,
      // текста для fillPartiesFromText не существует. Всё, что вернулось, — от
      // модели.
      consigneeFromModel: true,
      expected: matchExpectation(b.parsed, index, expectations),
    });
    comparisons.push(comparison);

    console.log(
      (comparison.changed.length === 0 ? 'ок' : `РАСХОЖДЕНИЯ (${comparison.changed.length})`) +
        `, №${b.parsed.docNumber ?? '∅'}, позиций ${b.parsed.items.length}` +
        `, грузополучатель: ${b.parsed.consignee?.name ?? '∅'}`,
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

  const calls = await collectCalls(startedAt);
  const mixed = [...mixedModelPrompts(calls).entries()];
  if (mixed.length > 0) {
    // Справочно: на сегментном пути провайдер один (только OpenRouter), но в
    // журнал попадают и вызовы классификатора страниц.
    console.log('\n[segment-ab] моделей за прогон — больше одной:');
    for (const [promptId, models] of mixed) {
      const which = promptId === base.id ? baseName : promptId === fresh.id ? newName : promptId;
      console.log(`  ${which}: ${models.join(', ')}`);
    }
  }
  if (providerMismatch.length > 0) {
    console.log(`\n[segment-ab] РАЗНЫЕ МОДЕЛИ НА ОДНОМ СЕГМЕНТЕ (${providerMismatch.length}):`);
    for (const label of providerMismatch) console.log(`  ${label}`);
  }

  const blockers = evaluateGate({ checkedUnits: comparisons.length, failures, comparisons });
  if (providerMismatch.length > 0) {
    blockers.push(`разные модели на одном сегменте: ${providerMismatch.length}`);
  }

  if (outPath) {
    const report = {
      formatVersion: 1 as const,
      // Отдельный вид, а не 'upd': свод сегментных частей с корпусными дал бы
      // бессмысленное покрытие — это разные наборы проверяемых единиц.
      docKind: 'upd-segment',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      window: { offset, limit, selected: allSegments.length, taken: work.length },
      files: work.map((sg) => `сегмент ${sg.segmentIndex} (страницы ${sg.pages.join(',')})`),
      corpus: {
        dir,
        manifestPath: expectedPath ?? null,
        // Отпечаток того, ПО ЧЕМУ сверяли: эталон, если задан, иначе сам
        // комплект страниц. Части, снятые с разных комплектов, свести нельзя.
        manifestSha256: sha256(expectedRaw ?? pagesHash),
        entries: allSegments.length,
        pagesHash,
        pages: pages.length,
        segmentationConfident: plan.confident,
      },
      git: gitRevision(),
      prompts: {
        base: { name: baseName, id: base.id, sha256: sha256(base.content), length: base.content.length },
        fresh: { name: newName, id: fresh.id, sha256: sha256(fresh.content), length: fresh.content.length },
      },
      calls,
      providerMismatch,
      failures,
      comparisons,
      blockers,
    };
    await writeReportSafely(outPath, report, (line) => console.log(`[segment-ab] ${line}`));
  }

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
