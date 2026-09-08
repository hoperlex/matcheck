/**
 * Оффлайн-прогон промпта классификации страниц: сравнить прежний ответ с
 * расширенным (с номером документа) НА ТЕХ ЖЕ картинках.
 *
 * Зачем. Промпт классификации — один и тот же вызов и для нарезки, и для
 * отбора страниц. Значит «shadow-режим» на бою уже менял бы поведение: новый
 * текст промпта мог бы сдвинуть сами типы страниц. Проверка обязана пройти
 * ВНЕ боевого пути — здесь.
 *
 * Скрипт НИЧЕГО не пишет: только SELECT, чтение файлов из S3 и вызовы модели.
 * Вызовы платные — перед стартом печатается их ожидаемое число.
 *
 * ЧТО ЭТОТ СКРИПТ ДОЛЖЕН ДОКАЗАТЬ. Не «полезность» разреза по номеру, а его
 * БЕЗОПАСНОСТЬ: ни одна страница-шапка не потеряна и ни одна граница не
 * проведена там, где её не было. Доля прочитанных номеров — метрика пользы, и
 * воротами она не является.
 *
 * Прежняя версия таких гарантий не давала, и это выяснилось при разборе:
 *   - потерянные шапки считались обходом ТОЛЬКО нового ответа, поэтому
 *     страница, которую модель не вернула вовсе, в счётчик не попадала;
 *   - изменение нарезки фиксировалось по числу сегментов — сдвиг границы при
 *     том же количестве проходил незаметно;
 *   - за эталон принимался результат ПРЕЖНЕГО вызова модели, а он
 *     недетерминирован: часть расхождений объяснялась не промптом, а разбросом
 *     самой модели;
 *   - выборка была «10 пакетов, отсортированных по UUID».
 *
 * ВАЖНО про подготовку страниц: повторяется путь СБОРКИ — рендер в адаптивном
 * разрешении и уменьшение toClassifyThumb до 700 px. Рендерить сразу в
 * CLASSIFY_DPI нельзя: это другая картинка, и эксперимент померил бы не то,
 * что происходит на бою.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/page-classify-number-backtest.ts \
 *     --bundle 62eac60f-d661-4cff-b1a9-503fd2f51e9c
 *   pnpm --filter @matcheck/api tsx scripts/page-classify-number-backtest.ts --days 14 --limit 20
 *   # контрольный случай — пакет приёмки, где два УПД слиплись в один документ:
 *   pnpm --filter @matcheck/api tsx scripts/page-classify-number-backtest.ts --delivery 13754
 *   # оценить разброс самой модели, не меняя промпта:
 *   pnpm --filter @matcheck/api tsx scripts/page-classify-number-backtest.ts --repeat 3
 */
import postgres from 'postgres';
import { getObject } from '../src/domain/storage/s3.signer.js';
import { renderPdf, toClassifyThumb, imageToVisionPage } from '../src/domain/edo/page-render.js';
import {
  classifyPages,
  PAGE_CLASSIFY_PROMPT,
  PAGE_CLASSIFY_WITH_NUMBER_PROMPT,
  type PageClassification,
} from '../src/domain/edo/upd-page-prefilter.js';
import {
  analyseBundle,
  safetyGate,
  type BundleReport,
} from '../src/domain/edo/page-classify-backtest-report.js';
import { decryptField, buildAad } from '../src/domain/auth/crypto.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('нужен DATABASE_URL');
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const bundleArg = argOf('bundle');
const deliveryArg = argOf('delivery');
const days = Number(argOf('days') ?? 14);
const limit = Number(argOf('limit') ?? 10);
/** Сколько раз повторить НОВЫЙ промпт на одном пакете: разброс модели. */
const repeat = Math.max(1, Number(argOf('repeat') ?? 1));
/**
 * Откуда берётся эталон.
 *
 * `evidence` (по умолчанию) — сохранённый боевой ответ классификатора из
 * recognition_evidence_events. Это единственный способ сравнивать с тем, что
 * на бою действительно произошло: повторный вызов старого промпта даёт свой
 * разброс, и часть расхождений придётся списать на модель, а не на промпт.
 * `model` — перевызвать старый промпт (нужно, когда улики нет).
 */
const baselineMode = (argOf('baseline') ?? 'evidence') as 'evidence' | 'model';
/** Только пакеты, где документов было больше одного: там разрез и применим. */
const multiOnly = args.includes('--multi-only');
/** Предел страниц на сегмент — тот же, что в воркере. */
const MAX_PAGES_PER_SEGMENT = 5;
/** Размер порции классификации — тот же, что в воркере. */
const CHUNK = 15;

const sql = postgres(DATABASE_URL, { max: 2 });

type FileRow = { bundle_id: string; s3_key: string; filename: string; mime_type: string | null };

async function creds(): Promise<{ apiBaseUrl: string; apiKey: string; model: string }> {
  const [provider] = await sql<{ model: string; kind: string }[]>`
    SELECT model, kind FROM llm_providers WHERE is_default = true LIMIT 1`;
  const [cred] = await sql<{ api_base_url: string; api_key_encrypted: unknown }[]>`
    SELECT api_base_url, api_key_encrypted FROM llm_provider_credentials
    WHERE kind = 'openrouter' LIMIT 1`;
  if (!provider || !cred) throw new Error('нет провайдера openrouter по умолчанию');
  return {
    apiBaseUrl: cred.api_base_url,
    apiKey: decryptField(
      cred.api_key_encrypted as never,
      buildAad('llm_provider_credentials', 'openrouter'),
    ),
    model: provider.model,
  };
}

/** Страницы пакета ровно так, как их готовит сборка. */
async function thumbsOfBundle(files: FileRow[]): Promise<Buffer[]> {
  const thumbs: Buffer[] = [];
  for (const f of files) {
    const buffer = await getObject(f.s3_key);
    const pages =
      (f.mime_type ?? '').includes('pdf') || f.filename.toLowerCase().endsWith('.pdf')
        ? await renderPdf(buffer)
        : [await imageToVisionPage(buffer)];
    for (const page of pages) thumbs.push(await toClassifyThumb(page));
  }
  return thumbs;
}

async function classifyAll(
  thumbs: Buffer[],
  prompt: string,
  maxTokens: number,
  c: Awaited<ReturnType<typeof creds>>,
): Promise<PageClassification[]> {
  const out: PageClassification[] = [];
  let offset = 0;
  for (let i = 0; i < thumbs.length; i += CHUNK) {
    const slice = thumbs.slice(i, i + CHUNK);
    const res = await classifyPages({ ...c, thumbs: slice, prompt, maxTokens });
    for (const c2 of res.classification) out.push({ ...c2, page: c2.page + offset });
    offset += slice.length;
  }
  return out.sort((a, b) => a.page - b.page);
}

/**
 * Сохранённый боевой ответ классификатора.
 *
 * Возвращает null, если улики нет или её нумерация не сходится с нашими
 * страницами: улика пишется для ДОЧЕРНЕГО пакета, и при другом составе файлов
 * номера страниц означали бы не то же самое. Молча подставлять такой эталон
 * нельзя — сравнение стало бы бессмысленным, а выглядело бы рабочим.
 */
async function baselineFromEvidence(
  bundleId: string,
  pageCount: number,
): Promise<PageClassification[] | null> {
  const [row] = await sql<{ payload: { classification?: PageClassification[] } }[]>`
    SELECT payload FROM recognition_evidence_events
    WHERE bundle_id = ${bundleId} AND evidence_type = 'page_classification'
    ORDER BY created_at DESC LIMIT 1`;
  const cls = row?.payload?.classification;
  if (!Array.isArray(cls) || cls.length === 0) return null;
  const maxPage = Math.max(...cls.map((c) => c.page));
  if (maxPage > pageCount) return null;
  return [...cls].sort((a, b) => a.page - b.page);
}

async function selectBundles(): Promise<string[]> {
  if (bundleArg) return [bundleArg];
  if (deliveryArg) {
    // Пакет по номеру приёмки: документы висят на ДОЧЕРНЕМ пакете, а файлы —
    // на корневом, поэтому поднимаемся к родителю.
    const rows = await sql<{ id: string }[]>`
      SELECT DISTINCT coalesce(b.parent_bundle_id, b.id) AS id
      FROM deliveries d
      JOIN delivery_sources ds ON ds.delivery_id = d.id
      JOIN source_documents sd ON sd.id = ds.source_document_id
      JOIN source_bundles b ON b.id = sd.bundle_id
      WHERE d.display_id = ${Number(deliveryArg)}`;
    return rows.map((r) => r.id);
  }
  // Выборка: свежие корневые пакеты с файлами. Прежняя сортировка по UUID
  // давала произвольные десять штук и ничего не представляла.
  const rows = await sql<{ id: string }[]>`
    SELECT b.id
    FROM source_bundles b
    WHERE b.parent_bundle_id IS NULL
      AND b.created_at >= now() - ${`${days} days`}::interval
      AND EXISTS (
        SELECT 1 FROM bundle_import_items i
        WHERE i.bundle_id = b.id AND i.input_s3_key IS NOT NULL)
      ${
        multiOnly
          ? sql`AND (
              SELECT count(*) FROM source_documents sd
              JOIN source_bundles sb ON sb.id = sd.bundle_id
              WHERE (sb.id = b.id OR sb.parent_bundle_id = b.id) AND sd.is_technical = false
            ) >= 2`
          : sql``
      }
    ORDER BY b.created_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const c = await creds();
  const bundleIds = await selectBundles();
  if (bundleIds.length === 0) {
    console.error('пакеты не найдены — проверьте --bundle / --delivery / --days');
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  console.info(
    `пакетов: ${bundleIds.length}; эталон: ${baselineMode}; ` +
      `повторов нового промпта: ${repeat}` +
      (baselineMode === 'model' ? '; ВНИМАНИЕ: эталон перевызывается, разброс модели войдёт в расхождения' : ''),
  );

  const reports: BundleReport[] = [];
  const skipped: Array<{ bundleId: string; reason: string }> = [];

  for (const bundleId of bundleIds) {
    const files = await sql<FileRow[]>`
      SELECT bundle_id, input_s3_key AS s3_key, source_filename AS filename, mime_type
      FROM bundle_import_items
      WHERE bundle_id = ${bundleId} AND input_s3_key IS NOT NULL
      ORDER BY input_order`;
    if (files.length === 0) {
      skipped.push({ bundleId, reason: 'нет файлов' });
      continue;
    }

    let thumbs: Buffer[];
    try {
      thumbs = await thumbsOfBundle(files);
    } catch (err) {
      skipped.push({ bundleId, reason: `страницы не подготовились: ${String(err)}` });
      continue;
    }
    if (thumbs.length === 0) {
      skipped.push({ bundleId, reason: 'нет страниц' });
      continue;
    }

    let baseline =
      baselineMode === 'evidence' ? await baselineFromEvidence(bundleId, thumbs.length) : null;
    if (!baseline) {
      if (baselineMode === 'evidence') {
        // Честно сообщаем о подмене эталона: иначе часть расхождений
        // объяснялась бы разбросом модели, а выглядела бы эффектом промпта.
        console.info(`  ${bundleId}: сохранённого ответа нет — эталон перевызывается моделью`);
      }
      baseline = await classifyAll(thumbs, PAGE_CLASSIFY_PROMPT, 1024, c);
    }

    const repeats: PageClassification[][] = [];
    for (let i = 0; i < repeat; i += 1) {
      repeats.push(await classifyAll(thumbs, PAGE_CLASSIFY_WITH_NUMBER_PROMPT, 3072, c));
    }
    const next = repeats[0]!;

    const report = analyseBundle({
      bundleId,
      pageCount: thumbs.length,
      maxPagesPerSegment: MAX_PAGES_PER_SEGMENT,
      baseline,
      next,
      repeats,
    });
    reports.push(report);

    const changed = report.boundariesBefore !== report.boundariesAfter;
    if (changed || report.lostMain.length > 0 || report.missingNew.length > 0) {
      console.info(`\nпакет ${bundleId} · страниц ${report.pages}`);
      if (changed) {
        console.info(`  границы: ${report.boundariesBefore} → ${report.boundariesAfter}`);
      }
      for (const t of report.typeChanges) {
        console.info(
          `  стр.${t.page}: ${t.from} → ${t.to}${t.docNumber ? ` (номер ${t.docNumber})` : ''}`,
        );
      }
      for (const l of report.lostMain) console.info(`  ПОТЕРЯНА ШАПКА стр.${l.page} → ${l.became}`);
      if (report.missingNew.length > 0) {
        console.info(`  модель не вернула страницы: ${report.missingNew.join(', ')}`);
      }
      if (report.confidentBefore !== report.confidentAfter) {
        console.info(`  confident: ${report.confidentBefore} → ${report.confidentAfter}`);
      }
      if (report.unstablePages.length > 0) {
        console.info(`  разброс самого промпта на стр.: ${report.unstablePages.join(', ')}`);
      }
    }
  }

  const sum = (pick: (r: BundleReport) => number): number =>
    reports.reduce((a, r) => a + pick(r), 0);
  const gate = safetyGate(reports);
  const mainPages = sum((r) => r.mainPages);
  const mainWithNumber = sum((r) => r.mainWithNumber);
  const boundaryChanged = reports.filter((r) => r.boundariesBefore !== r.boundariesAfter);
  const unstable = sum((r) => r.unstablePages.length);

  console.info('\n── итог ──');
  console.info(`пакетов разобрано: ${reports.length}, пропущено: ${skipped.length}`);
  for (const s of skipped) console.info(`  пропущен ${s.bundleId}: ${s.reason}`);
  console.info(`страниц: ${sum((r) => r.pages)}`);
  console.info(`изменений типа: ${sum((r) => r.typeChanges.length)}`);
  console.info(`пакетов с изменившимися ГРАНИЦАМИ: ${gate.boundariesChanged}`);
  for (const r of boundaryChanged) {
    console.info(`  ${r.bundleId}: ${r.boundariesBefore} → ${r.boundariesAfter}`);
  }
  console.info(`потеря уверенности (confident true → false): ${gate.confidenceLost}`);
  if (repeat > 1) console.info(`страниц с разбросом самого промпта: ${unstable}`);
  console.info(
    `номер прочитан на шапках: ${mainWithNumber}/${mainPages}` +
      (mainPages > 0 ? ` (${Math.round((100 * mainWithNumber) / mainPages)}%)` : '') +
      ' — метрика ПОЛЬЗЫ, не ворота',
  );

  // Ворота безопасности. Изменившиеся границы сами по себе не провал — ради
  // них всё и затевалось, — но каждую надо разметить глазами по оригиналу.
  console.info('\n── ворота безопасности ──');
  console.info(`потерянных шапок: ${gate.lostMain}  ← должно быть 0`);
  console.info(`страниц, не вернувшихся из модели: ${gate.missingNew}  ← должно быть 0`);
  console.info(
    `границ к ручной разметке: ${gate.boundariesChanged}` +
      (gate.boundariesChanged > 0 ? ' — сверить с оригиналами до включения' : ''),
  );
  console.info(gate.passed ? 'ВОРОТА ПРОЙДЕНЫ' : 'ВОРОТА НЕ ПРОЙДЕНЫ');

  await sql.end({ timeout: 5 });
  // Ненулевой код — чтобы ворота нельзя было «пройти», не заметив вывода.
  if (!gate.passed) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
