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
 *
 * Что меряет:
 *   - расхождения в типах страниц (главный риск: upd_main → не-main теряет
 *     документ так же, как терял старый механизм);
 *   - долю страниц-шапок, на которых номер вообще прочитан (ниже 80 % правило
 *     почти не сработает — сначала надо поднимать разрешение миниатюры);
 *   - как изменилась бы нарезка.
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
import { planUpdSegments } from '../src/domain/edo/upd-assembly.js';
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
const days = Number(argOf('days') ?? 14);
const limit = Number(argOf('limit') ?? 10);
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

async function main(): Promise<void> {
  const c = await creds();
  const bundles = bundleArg
    ? [{ id: bundleArg }]
    : await sql<{ id: string }[]>`
        SELECT DISTINCT b.id
        FROM source_bundles b
        JOIN bundle_import_items i ON i.bundle_id = b.id
        JOIN recognition_evidence_events e ON e.bundle_id = b.id
         AND e.evidence_type = 'page_classification'
        WHERE b.created_at >= now() - ${`${days} days`}::interval
        ORDER BY b.id
        LIMIT ${limit}`;

  let pagesTotal = 0;
  let mainPages = 0;
  let mainWithNumber = 0;
  let typeChanges = 0;
  let mainLost = 0;
  const splits: Array<{ bundleId: string; was: number; will: number }> = [];

  for (const b of bundles) {
    const files = await sql<FileRow[]>`
      SELECT bundle_id, input_s3_key AS s3_key, source_filename AS filename, mime_type
      FROM bundle_import_items
      WHERE bundle_id = ${b.id} AND input_s3_key IS NOT NULL
      ORDER BY input_order`;
    if (files.length === 0) continue;

    let thumbs: Buffer[];
    try {
      thumbs = await thumbsOfBundle(files);
    } catch (err) {
      console.error(`пакет ${b.id}: не удалось подготовить страницы — ${String(err)}`);
      continue;
    }
    if (thumbs.length === 0) continue;

    const oldCls = await classifyAll(thumbs, PAGE_CLASSIFY_PROMPT, 1024, c);
    const newCls = await classifyAll(thumbs, PAGE_CLASSIFY_WITH_NUMBER_PROMPT, 3072, c);

    const oldByPage = new Map(oldCls.map((x) => [x.page, x]));
    for (const page of newCls) {
      pagesTotal++;
      const before = oldByPage.get(page.page);
      if (before?.type === 'upd_main') {
        mainPages++;
        if (page.docNumber != null) mainWithNumber++;
        if (page.type !== 'upd_main') mainLost++;
      }
      if (before && before.type !== page.type) {
        typeChanges++;
        console.info(
          `пакет ${b.id} стр.${page.page}: тип ${before.type} → ${page.type}` +
            (page.docNumber ? ` (номер ${page.docNumber})` : ''),
        );
      }
    }

    const planOld = planUpdSegments(oldCls, thumbs.length, MAX_PAGES_PER_SEGMENT);
    const planNew = planUpdSegments(newCls, thumbs.length, MAX_PAGES_PER_SEGMENT, {
      splitByDocNumber: true,
    });
    if (planOld.segments.length !== planNew.segments.length) {
      splits.push({ bundleId: b.id, was: planOld.segments.length, will: planNew.segments.length });
      const opened = planNew.segments.filter((s) => s.reasons[0] === 'opened_by_doc_number_change');
      console.info(
        `пакет ${b.id}: сегментов ${planOld.segments.length} → ${planNew.segments.length}` +
          (opened.length > 0
            ? `; разрез на стр. ${opened.map((s) => `${s.pages[0]} (${s.docNumber ?? '—'})`).join(', ')}`
            : ''),
      );
    }
  }

  console.info('\n── итог ──');
  console.info(`страниц: ${pagesTotal}`);
  console.info(`изменений типа: ${typeChanges}`);
  console.info(`из них потерянных шапок (upd_main → не main): ${mainLost}  ← должно быть 0`);
  console.info(
    `номер прочитан на шапках: ${mainWithNumber}/${mainPages}` +
      (mainPages > 0 ? ` (${Math.round((100 * mainWithNumber) / mainPages)}%)  ← нужно ≥80%` : ''),
  );
  console.info(`пакетов с изменившейся нарезкой: ${splits.length}`);
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
