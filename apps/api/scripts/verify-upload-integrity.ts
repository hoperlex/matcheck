/**
 * Проверка гарантии «ни один принятый файл не исчезает».
 *
 * Read-only: только SELECT и HEAD-запросы в S3. Ничего не пишет и не меняет —
 * безопасно запускать на проде.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/verify-upload-integrity.ts
 *   pnpm --filter @matcheck/api tsx scripts/verify-upload-integrity.ts --days 30
 *   pnpm --filter @matcheck/api tsx scripts/verify-upload-integrity.ts --bundle 563bdaae-...,84449539-...
 *   pnpm --filter @matcheck/api tsx scripts/verify-upload-integrity.ts --skip-s3
 *
 * Что проверяется (инвариант из плана, а не равенство «загружено N → видно N»:
 * равенство неверно — накладная даёт N документов из одного файла, пачка
 * счёт-фактур один документ из многих, одинаковый файл из двух зон схлопывается):
 *
 *   1. У пакета в терминальном состоянии каждая строка реестра активного
 *      поколения имеет ТЕРМИНАЛЬНЫЙ исход (created / skipped / failed).
 *   2. created → существует живой нетехнический документ ЛИБО дочерний пакет
 *      с документами. Иначе файл не виден нигде.
 *   3. skipped / failed → есть ключ S3 и объект по нему доступен: такие файлы
 *      показываются только через карточку поставки и «Без документов», и без
 *      живого объекта показывать нечего.
 *   4. Число принятых записей манифеста публичной отправки (с поправкой на
 *      дубли по sha256) сходится с числом строк реестра.
 *   5. У живого нетехнического документа (пакета И его дочерних) объект-оригинал
 *      каждого вложения доступен в S3. Проверки 1–4 смотрят со стороны реестра,
 *      а файл может пропасть и у давно разобранного документа: один объект
 *      штатно делят несколько документов, и до 8c5f821 удаление одного из них
 *      уносило файл у остальных — junction-строка остаётся, объекта нет.
 *
 * Каждое нарушение печатается строкой: пакет, файл, что не так.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const days = Number(argValue('--days') ?? '7');
const bundlesArg = argValue('--bundle');
const skipS3 = process.argv.includes('--skip-s3');

const TERMINAL = new Set(['created', 'skipped', 'failed']);

type Violation = {
  bundleId: string;
  filename: string;
  kind: string;
  detail: string;
};

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 4 });
  // S3 подключаем лениво: с --skip-s3 модуль не нужен вовсе, а он требует
  // заполненных S3_* переменных.
  const headObject = skipS3
    ? null
    : (await import('../src/domain/storage/s3.signer.js')).headObject;

  const bundles = bundlesArg
    ? await sql<{ id: string; status: string; active_upload_generation: number }[]>`
        SELECT id, status, active_upload_generation FROM source_bundles
         WHERE id = ANY(${bundlesArg.split(',').map((s) => s.trim())}::uuid[])`
    : await sql<{ id: string; status: string; active_upload_generation: number }[]>`
        SELECT id, status, active_upload_generation FROM source_bundles
         WHERE parent_bundle_id IS NULL
           AND created_at > now() - make_interval(days => ${days})
         ORDER BY created_at`;

  const violations: Violation[] = [];
  let itemsChecked = 0;
  let attachmentsChecked = 0;
  // Объект в бакете может принадлежать нескольким документам, поэтому HEAD
  // делаем один раз на ключ: 11 документов на одном PDF не должны дать 11
  // запросов к flaky-хранилищу. Кеш живёт на весь прогон — один и тот же ключ
  // встречается и в соседних пакетах (слияние дубликатов).
  const headCache = new Map<string, boolean>();
  let sharedKeys = 0;
  let maxOwners = 0;

  for (const bundle of bundles) {
    // Правило выборки то же, что в приложении: есть строки активного
    // поколения — берём только их, иначе legacy-строки без поколения.
    const rows = await sql<
      {
        id: string;
        source_filename: string;
        input_s3_key: string | null;
        status: string;
        effective_status: string | null;
        resolved_at: Date | null;
        created_document_ids: string[];
        sub_bundle_id: string | null;
      }[]
    >`
      WITH active AS (
        SELECT * FROM bundle_import_items
         WHERE bundle_id = ${bundle.id}
           AND upload_generation = ${bundle.active_upload_generation}
      )
      SELECT id, source_filename, input_s3_key, status, effective_status, resolved_at,
             created_document_ids, sub_bundle_id
        FROM active
       UNION ALL
      SELECT id, source_filename, input_s3_key, status, effective_status, resolved_at,
             created_document_ids, sub_bundle_id
        FROM bundle_import_items
       WHERE bundle_id = ${bundle.id}
         AND upload_generation IS NULL
         AND NOT EXISTS (SELECT 1 FROM active)`;

    const bundleTerminal = bundle.status === 'parsed' || bundle.status === 'parse_failed';

    for (const row of rows) {
      itemsChecked += 1;
      const effective = row.effective_status ?? row.status;

      // 1. Терминальность. У пакета, который ещё разбирается, строка законно
      // может быть в работе — придираемся только к завершённым.
      if (bundleTerminal && !TERMINAL.has(effective)) {
        violations.push({
          bundleId: bundle.id,
          filename: row.source_filename,
          kind: 'not_terminal',
          detail: `исход не назван: status=${row.status}, effective=${row.effective_status ?? '—'}`,
        });
        continue;
      }

      // Закрытая строка — сознательно снятый вопрос: документ удалили менеджером
      // (closeRegistryRowsForDeletedDocument ставит resolved_at в той же
      // транзакции), либо файл разобрали вручную. Ни отсутствие документа, ни
      // отсутствие объекта тут не дефект: файл уходит в чистку S3 вместе с
      // документом. Без этой строки каждое удаление НАВСЕГДА добавляло бы в
      // вывод по нарушению, и настоящие проблемы в нём тонули бы: на бою 22 из
      // 24 нарушений были ровно такими.
      //
      // Проверка 1 выше намеренно раньше: «исход не назван» — это про то, что
      // разбор не завершился, и закрытие строки этого не отменяет.
      if (row.resolved_at) continue;

      // 2. created → живой документ (свой или в дочернем пакете).
      if (effective === 'created') {
        const ids = Array.isArray(row.created_document_ids) ? row.created_document_ids : [];
        const [own] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM source_documents
           WHERE id = ANY(${ids}::uuid[]) AND is_technical = false`;
        const [child] = row.sub_bundle_id
          ? await sql<{ n: number }[]>`
              SELECT count(*)::int AS n FROM source_documents
               WHERE bundle_id = ${row.sub_bundle_id} AND is_technical = false`
          : [{ n: 0 }];
        if ((own?.n ?? 0) === 0 && (child?.n ?? 0) === 0) {
          violations.push({
            bundleId: bundle.id,
            filename: row.source_filename,
            kind: 'no_document',
            detail: row.sub_bundle_id
              ? `дочерний пакет ${row.sub_bundle_id} документов не дал, а исход не помечен failed`
              : 'документ создан не был либо удалён',
          });
        }
        continue;
      }

      // 3. skipped / failed → файл должен быть доступен.
      if (!row.input_s3_key) {
        violations.push({
          bundleId: bundle.id,
          filename: row.source_filename,
          kind: 'no_s3_key',
          detail: 'ключ файла не сохранён — показать нечего (кандидат на ремонт)',
        });
        continue;
      }
      if (headObject) {
        const exists = await headObject(row.input_s3_key).catch((err: unknown) => {
          violations.push({
            bundleId: bundle.id,
            filename: row.source_filename,
            kind: 's3_error',
            detail: err instanceof Error ? err.message : String(err),
          });
          return true;
        });
        if (!exists) {
          violations.push({
            bundleId: bundle.id,
            filename: row.source_filename,
            kind: 'file_missing',
            detail: `объект ${row.input_s3_key} в хранилище отсутствует`,
          });
        }
      }
    }

    // 4. Сверка с манифестом публичной отправки.
    const events = await sql<{ manifest: unknown }[]>`
      SELECT submission_manifest AS manifest FROM ingest_events
       WHERE bundle_id = ${bundle.id} AND channel = 'public'`;
    const accepted = events
      .flatMap((e) => (Array.isArray(e.manifest) ? e.manifest : []))
      .filter((m): m is { filename: string; accepted: boolean; sha256?: string } =>
        Boolean(m && typeof m === 'object' && (m as { accepted?: boolean }).accepted),
      );
    if (accepted.length > 0) {
      // Дубли между зонами схлопываются в одну строку реестра — считаем по
      // хешу. У манифестов до этой правки хеша нет: там сверяем по именам,
      // и совпадение имён тоже считаем дублем.
      const distinct = new Set(accepted.map((m) => m.sha256 ?? m.filename));
      if (distinct.size > rows.length) {
        violations.push({
          bundleId: bundle.id,
          filename: `${distinct.size} принято / ${rows.length} в реестре`,
          kind: 'manifest_mismatch',
          detail: 'принятые файлы не дошли до реестра входных файлов',
        });
      }
    }

    // 5. Вложения живых документов: объект-оригинал на месте.
    //
    // Документы берём и из ДОЧЕРНИХ пакетов: накладная разворачивается в
    // под-пакет, сборка УПД тоже, и без этого проверка прошла бы мимо всей
    // зоны риска — именно там несколько документов делят один файл.
    //
    // Только role='original': extracted_text — производная, её восстанавливает
    // переразбор, и удваивать HEAD-запросы ради неё незачем.
    const attachments = await sql<
      { doc_id: string; doc_number: string | null; s3_key: string }[]
    >`
      SELECT d.id AS doc_id, d.doc_number, a.s3_key
        FROM source_document_attachments a
        JOIN source_documents d ON d.id = a.source_document_id
       WHERE d.is_technical = false
         AND a.role = 'original'
         AND (d.bundle_id = ${bundle.id}
              OR d.bundle_id IN (SELECT id FROM source_bundles
                                  WHERE parent_bundle_id = ${bundle.id}))`;

    const ownersByKey = new Map<string, { doc_id: string; doc_number: string | null }[]>();
    for (const att of attachments) {
      const owners = ownersByKey.get(att.s3_key);
      if (owners) owners.push(att);
      else ownersByKey.set(att.s3_key, [att]);
    }

    for (const [key, owners] of ownersByKey) {
      attachmentsChecked += owners.length;
      if (owners.length > 1) {
        sharedKeys += 1;
        maxOwners = Math.max(maxOwners, owners.length);
      }
      if (!headObject) continue;

      let exists = headCache.get(key);
      if (exists === undefined) {
        exists = await headObject(key).catch((err: unknown) => {
          violations.push({
            bundleId: bundle.id,
            filename: key,
            kind: 's3_error',
            detail: err instanceof Error ? err.message : String(err),
          });
          // Как и в проверке 3: сетевой сбой не выдаём за потерю данных.
          return true;
        });
        headCache.set(key, exists);
      }
      if (exists) continue;

      // Одно нарушение на объект, но со списком всех осиротевших документов —
      // иначе один пропавший PDF дал бы одиннадцать одинаковых строк.
      const named = owners.map((o) => o.doc_number ?? `id:${o.doc_id.slice(0, 8)}`).join(', ');
      violations.push({
        bundleId: bundle.id,
        filename: named,
        kind: 'attachment_object_missing',
        detail: `объект ${key} отсутствует; документов без файла: ${owners.length}`,
      });
    }
  }

  const summary = [
    `Проверено пакетов: ${bundles.length}`,
    `строк реестра: ${itemsChecked}`,
    `вложений-оригиналов: ${attachmentsChecked}`,
  ];
  // Зона риска видна, даже когда все файлы на месте: это те группы, где до
  // 8c5f821 удаление одного документа уносило файл у остальных.
  if (sharedKeys > 0) {
    summary.push(
      `объектов с несколькими владельцами: ${sharedKeys} (максимум на объект: ${maxOwners})`,
    );
  }
  console.log(summary.join(', '));
  if (skipS3) console.log('S3 не проверялся (--skip-s3): наличие объектов не подтверждено');
  if (violations.length === 0) {
    console.log('Нарушений инварианта нет.');
  } else {
    console.log(`\nНАРУШЕНИЙ: ${violations.length}\n`);
    for (const v of violations) {
      console.log(`  [${v.kind}] ${v.bundleId}  ${v.filename}\n      ${v.detail}`);
    }
  }

  await sql.end({ timeout: 5 });
  // Ненулевой код — чтобы прогон из cron/CI было видно без чтения вывода.
  if (violations.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
