/**
 * Online-index runner (Волна 1A) — безопасное создание индексов на ЖИВОЙ проде.
 * Запуск: pnpm --filter @matcheck/api tsx scripts/create-indexes-online.ts
 *
 * Зачем отдельный прогон, а не обычная миграция: migrate.ts применяет каждую
 * миграцию в ОДНОЙ транзакции, а CREATE INDEX CONCURRENTLY в транзакции
 * запрещён. Обычный же CREATE INDEX берёт SHARE-лок и блокирует запись фото/
 * документов с планшетов на время построения. Этот runner строит индексы
 * CONCURRENTLY (лок SHARE UPDATE EXCLUSIVE — запись НЕ блокируется).
 *
 * Порядок: сначала прогнать ЭТОТ скрипт на проде, затем обычный деплой —
 * миграция 0071 (CREATE INDEX IF NOT EXISTS) увидит готовые индексы и станет
 * мгновенным no-op. Список индексов ЗЕРКАЛИТ 0071_perf_indexes.sql (имена и
 * определения обязаны совпадать — миграция сверяет по имени через IF NOT EXISTS).
 *
 * Гарантии: только CONCURRENTLY; после каждого — проверка indisvalid/indisready
 * и pg_get_indexdef; invalid-индекс (после сбоя CONCURRENTLY) дропается и
 * пересоздаётся; в конце — целевой ANALYZE. Идемпотентно (IF NOT EXISTS).
 */
import postgres from 'postgres';

interface IndexSpec {
  name: string;
  table: string;
  /** Тело определения БЕЗ CREATE INDEX ... — то, что идёт после имени таблицы. */
  columns: string;
}

// Зеркало 0071_perf_indexes.sql. При правке — синхронизировать оба файла.
const INDEXES: IndexSpec[] = [
  { name: 'delivery_items_delivery_line_idx', table: 'delivery_items', columns: '("delivery_id", "line_no")' },
  { name: 'shipment_items_shipment_line_idx', table: 'shipment_items', columns: '("shipment_id", "line_no")' },
  { name: 'delivery_photos_delivery_idx', table: 'delivery_photos', columns: '("delivery_id")' },
  { name: 'shipment_photos_shipment_idx', table: 'shipment_photos', columns: '("shipment_id")' },
  { name: 'delivery_sources_source_document_idx', table: 'delivery_sources', columns: '("source_document_id")' },
  { name: 'shipment_sources_source_document_idx', table: 'shipment_sources', columns: '("source_document_id")' },
  { name: 'source_document_items_source_document_idx', table: 'source_document_items', columns: '("source_document_id", "line_no")' },
  {
    name: 'source_document_attachments_source_document_idx',
    table: 'source_document_attachments',
    columns: '("source_document_id", "role", "created_at")',
  },
  {
    name: 'source_documents_direction_parsed_idx',
    table: 'source_documents',
    columns: '("direction", "parsed_at" DESC, "id" DESC)',
  },
  {
    name: 'source_documents_site_direction_parsed_idx',
    table: 'source_documents',
    columns: '("site_id", "direction", "parsed_at" DESC, "id" DESC)',
  },
];

async function verify(
  sql: ReturnType<typeof postgres>,
  name: string,
): Promise<{ exists: boolean; valid: boolean; ready: boolean; def: string | null }> {
  const rows = await sql<{ indisvalid: boolean; indisready: boolean; def: string }[]>`
    SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = ${name}
  `;
  if (rows.length === 0) return { exists: false, valid: false, ready: false, def: null };
  return { exists: true, valid: rows[0].indisvalid, ready: rows[0].indisready, def: rows[0].def };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[create-indexes] DATABASE_URL не задан');
    process.exit(1);
  }
  console.info('[create-indexes] connecting to', url.replace(/:[^:@]*@/, ':***@'));

  // max:1 — одно соединение на весь прогон (SET lock_timeout переживёт между
  // запросами). prepare:false — как в основном клиенте.
  const sql = postgres(url, { max: 1, prepare: false });

  try {
    // Ограничиваем ожидание конфликтующих локов: CONCURRENTLY ждёт завершения
    // текущих транзакций; при затыке не висим бесконечно, а падаем с ошибкой.
    await sql.unsafe(`SET lock_timeout = '10s'`);

    const affectedTables = new Set<string>();

    for (const idx of INDEXES) {
      const before = await verify(sql, idx.name);
      if (before.exists && before.valid && before.ready) {
        console.info(`[create-indexes] ${idx.name} — уже есть и valid, пропускаю`);
        continue;
      }
      // Если существует, но невалиден (остаток сбойного CONCURRENTLY) — дропаем.
      if (before.exists && !before.valid) {
        console.warn(`[create-indexes] ${idx.name} — INVALID, дропаю и пересоздаю`);
        await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${idx.name}"`);
      }

      console.info(`[create-indexes] строю ${idx.name} CONCURRENTLY ...`);
      // ВАЖНО: только CONCURRENTLY. Обычный CREATE INDEX на проде запрещён —
      // блокирует запись. IF NOT EXISTS делает прогон идемпотентным.
      await sql.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${idx.name}" ON "${idx.table}" ${idx.columns}`,
      );

      const after = await verify(sql, idx.name);
      if (!after.exists || !after.valid || !after.ready) {
        console.error(
          `[create-indexes] ${idx.name} — построение НЕ удалось (valid=${after.valid}, ready=${after.ready}). ` +
            `Разберитесь вручную (проверьте pg_stat_activity/логи), затем перезапустите.`,
        );
        process.exit(1);
      }
      console.info(`[create-indexes] ${idx.name} OK — ${after.def}`);
      affectedTables.add(idx.table);
    }

    // Целевой ANALYZE по затронутым таблицам — чтобы планировщик сразу увидел
    // новые индексы (без ожидания autovacuum).
    for (const table of affectedTables) {
      console.info(`[create-indexes] ANALYZE ${table}`);
      await sql.unsafe(`ANALYZE "${table}"`);
    }

    console.info(`[create-indexes] готово. индексов обработано: ${INDEXES.length}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[create-indexes] failed', err);
  process.exit(1);
});
