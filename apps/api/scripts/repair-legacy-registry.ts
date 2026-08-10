/**
 * Ремонт строк реестра, у которых потерян ключ файла (input_s3_key IS NULL).
 *
 * По бою таких 13 (12 needs_review + 1 failed): файл лежит в хранилище, но
 * прямой ссылки на него в реестре нет, поэтому он не показывается ни в
 * карточке поставки, ни во вкладке «Без документов». Автоматически переставить
 * router-job нельзя: пакет с хотя бы одним документом считается обработанным,
 * и повторная загрузка его не оживит.
 *
 * Ключ восстанавливается перебором: приём складывает файлы по формуле
 *   {siteCode}/{counterparty}/source-documents/{bundleId}/doc-N-{safeName}
 * где siteCode и контрагент известны из пакета, имя файла — в source_filename,
 * а N — порядковый номер в пачке. Листинга префикса в S3-клиенте нет (только
 * headObject), поэтому N перебирается 1..MAX_INDEX.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply и только после бэкапа.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/repair-legacy-registry.ts
 *   pnpm --filter @matcheck/api tsx scripts/repair-legacy-registry.ts --apply
 *   pnpm --filter @matcheck/api tsx scripts/repair-legacy-registry.ts --bundle <id> --apply
 *
 * Исходы:
 *   найден  → input_s3_key проставлен, effective_status='failed' — строка
 *             становится видимой через «Без документов» и карточку поставки;
 *   не найден → effective_status='lost': файл утрачен, его нужно запросить у
 *             поставщика повторно. Молча оставлять такую строку нельзя — она
 *             и есть «файл исчез».
 */
import postgres from 'postgres';
import { buildS3Key } from '../src/domain/storage/s3.path.js';
import { safeName } from '../src/domain/sourceDocuments/bundle-key.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const apply = process.argv.includes('--apply');
const bundleArg = argValue('--bundle');
/** Пачка публичной формы ограничена 10 файлами; запас на внутренние загрузки. */
const MAX_INDEX = 20;

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 4 });
  const { headObject } = await import('../src/domain/storage/s3.signer.js');

  const rows = await sql<
    {
      id: string;
      bundle_id: string;
      source_filename: string;
      status: string;
      effective_status: string | null;
      site_code: string | null;
      cp_inn: string | null;
      cp_name: string | null;
    }[]
  >`
    SELECT bi.id, bi.bundle_id, bi.source_filename, bi.status, bi.effective_status,
           s.code AS site_code, c.inn AS cp_inn, c.name AS cp_name
      FROM bundle_import_items bi
      JOIN source_bundles b ON b.id = bi.bundle_id
      LEFT JOIN sites s ON s.id = b.site_id
      LEFT JOIN counterparties c ON c.id = b.contractor_id
     WHERE bi.input_s3_key IS NULL
       ${bundleArg ? sql`AND bi.bundle_id = ${bundleArg}::uuid` : sql``}
     ORDER BY bi.bundle_id, bi.created_at`;

  console.log(`Строк без ключа файла: ${rows.length}${apply ? '' : '  (режим dry-run)'}`);

  let restored = 0;
  let lost = 0;

  for (const row of rows) {
    let found: string | null = null;
    for (let i = 0; i < MAX_INDEX && !found; i += 1) {
      const candidate = buildS3Key({
        site: row.site_code ? { code: row.site_code } : null,
        counterparty: row.cp_inn ? { inn: row.cp_inn, name: row.cp_name ?? '' } : null,
        entityType: 'source-documents',
        entityId: row.bundle_id,
        filename: `doc-${i + 1}-${safeName(row.source_filename, i)}`,
      });
      const exists = await headObject(candidate).catch((err: unknown) => {
        // Недоступность хранилища не повод объявить файл утраченным: в
        // следующий прогон он найдётся. Помечаем строку как непроверенную.
        console.log(`  ! ${row.source_filename}: S3 недоступен — ${String(err)}`);
        return null;
      });
      if (exists === null) {
        found = null;
        break;
      }
      if (exists) found = candidate;
    }

    if (found) {
      restored += 1;
      console.log(`  + ${row.source_filename}\n      ${found}`);
      if (apply) {
        await sql`UPDATE bundle_import_items
                     SET input_s3_key = ${found},
                         effective_status = 'failed',
                         reason = coalesce(reason, 'файл восстановлен ремонтом реестра'),
                         updated_at = now()
                   WHERE id = ${row.id}`;
      }
    } else {
      lost += 1;
      console.log(`  - ${row.source_filename}: файл не найден (пакет ${row.bundle_id})`);
      if (apply) {
        await sql`UPDATE bundle_import_items
                     SET effective_status = 'lost',
                         reason = 'файл утрачен — запросить у поставщика повторно',
                         updated_at = now()
                   WHERE id = ${row.id}`;
      }
    }
  }

  console.log(
    `\nИтог: восстановлено ${restored}, утрачено ${lost}.` +
      (apply ? '' : '\nЗапись не выполнялась. Повторите с --apply после бэкапа.'),
  );
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
