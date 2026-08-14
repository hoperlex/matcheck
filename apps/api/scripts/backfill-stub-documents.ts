/**
 * Поднимает принятые файлы, оставшиеся без документа.
 *
 * Зачем. Файл, загруженный через публичную форму, мог исчезнуть из «Документов»
 * шестью путями: зона «Дополнительные документы», сертификат по классификатору,
 * нераспознанная накладная (запись осталась технической), исчерпание ретраев,
 * сбой getObject, строка, не дошедшая до разбора. Объект при этом лежит в S3, а
 * менеджер видит «ничего не пришло». Новый код такие файлы больше не теряет, но
 * уже загруженные сами не появятся — их поднимает этот скрипт.
 *
 * Работает тем же кодом, что и воркер (ensureDocumentForRegistryRow): те же
 * проверки, включая наличие объекта в S3. Второго набора правил нет намеренно —
 * иначе бэкфилл и рантайм разошлись бы уже на первой правке.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы (как
 * repair-legacy-registry.ts). Запись только с --apply.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/backfill-stub-documents.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/backfill-stub-documents.ts --apply
 *   … --limit 500
 *
 * Требует применённой миграции 0099 (колонка stub_document_id и закрытие строк,
 * документ по которым удалён).
 */
import { sql as drSql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { sourceBundles } from '../src/db/schema.js';
import {
  ensureDocumentForRegistryRow,
  selectRowsWithoutDocument,
  stubReasonForRow,
} from '../src/domain/sourceDocuments/stub-documents.js';

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 500;

/**
 * Сводка по всем строкам реестра с файлом.
 *
 * Считать «без документа» по created_document_ids нельзя: waybill-путь его не
 * заполняет вовсе, и успешно разобранные накладные выглядели бы потерянными.
 * Поэтому опора на факт — вложение с тем же ключом у нетехнического документа.
 */
async function summary() {
  const rows = await db.execute<{ bucket: string; cnt: number }>(drSql`
    select case
             when bi.resolved_at is not null then 'закрыто человеком (в т.ч. удалённые документы)'
             when exists (
               select 1 from source_document_attachments a
                 join source_documents d on d.id = a.source_document_id
                where a.s3_key = bi.input_s3_key and not d.is_technical
             ) then 'документ есть'
             when bi.sub_bundle_id is null then 'без документа: обычная строка'
             else 'без документа: через дочерний пакет'
           end as bucket,
           count(*)::int as cnt
      from bundle_import_items bi
     where bi.input_s3_key is not null
     group by 1
     order by 2 desc
  `);
  console.log('[backfill] состояние реестра:');
  for (const r of rows) console.log(`  ${r.bucket}: ${r.cnt}`);
}

async function main() {
  await summary();

  const rows = await selectRowsWithoutDocument(db, { limit });
  if (rows.length === 0) {
    console.log('\n[backfill] файлов без документа не найдено.');
    return;
  }

  console.log(`\n[backfill] к обработке: ${rows.length} (limit=${limit})`);
  const counters = { created: 0, promoted: 0, exists: 0, resolved: 0, missing: 0, failed: 0 };

  for (const row of rows) {
    const reason = stubReasonForRow(row);
    const via = row.subBundleId ? 'через дочерний пакет' : 'обычная строка';
    if (!apply) {
      console.log(`  [dry] ${row.filename} — ${reason} (${via})`);
      continue;
    }

    const [bundle] = await db
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.id, row.bundleId))
      .limit(1);
    if (!bundle) {
      console.log(`  [!!] ${row.filename} — пакет исчез, пропуск`);
      counters.failed += 1;
      continue;
    }

    try {
      const res = await ensureDocumentForRegistryRow({ db, row, bundle, reason });
      switch (res.action) {
        case 'created':
          counters.created += 1;
          console.log(`  [+] ${row.filename} — заглушка ${res.documentId} (${reason})`);
          break;
        case 'promoted':
          counters.promoted += 1;
          console.log(`  [^] ${row.filename} — показана служебная запись ${res.documentId}`);
          break;
        case 'exists':
          counters.exists += 1;
          break;
        case 'resolved':
          counters.resolved += 1;
          break;
        case 'missing_object':
          counters.missing += 1;
          // Молчать нельзя: файла нет физически, и это не «всё хорошо».
          console.log(`  [x] ${row.filename} — объекта нет в S3, документ не заведён`);
          break;
      }
    } catch (err) {
      counters.failed += 1;
      console.log(`  [!!] ${row.filename} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!apply) {
    console.log('\n[backfill] запись не выполнялась. Повторите с --apply.');
    return;
  }
  console.log(
    `\n[backfill] итог: создано ${counters.created}, показано служебных ${counters.promoted},` +
      ` уже были ${counters.exists}, закрыто человеком ${counters.resolved},` +
      ` нет файла ${counters.missing}, ошибок ${counters.failed}.`,
  );
  if (rows.length === limit) {
    console.log('[backfill] выбран весь лимит — возможно, остались ещё. Повторите прогон.');
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
