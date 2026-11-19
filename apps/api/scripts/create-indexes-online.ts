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
 * миграции (CREATE INDEX IF NOT EXISTS) увидят готовые индексы и станут
 * мгновенным no-op. Список индексов ЗЕРКАЛИТ 0071_perf_indexes.sql,
 * 0093_refresh_session_idx.sql и 0154_bundle_root_and_s3_key_idx.sql (имена и
 * определения обязаны совпадать — миграция сверяет по имени через IF NOT EXISTS).
 *
 * Запуск на hub из УЖЕ РАБОТАЮЩЕГО образа, без сборки и пересоздания
 * контейнеров: свежая версия этого файла подкладывается поверх образной.
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps \
 *     -v "$PWD/apps/api/scripts/create-indexes-online.ts:/app/apps/api/scripts/create-indexes-online.ts:ro" \
 *     matcheck-api node_modules/.bin/tsx scripts/create-indexes-online.ts
 * Скрипт самодостаточен (только пакет postgres), поэтому код образа ему не важен.
 * Ненулевой код выхода = СТОП: деплой не запускать, перезапустить скрипт.
 *
 * Гарантии: только CONCURRENTLY; после каждого — проверка indisvalid/indisready
 * и pg_get_indexdef; invalid-индекс (после сбоя CONCURRENTLY) дропается и
 * пересоздаётся при следующем запуске; в конце каждого успешного прогона —
 * ANALYZE всех таблиц списка. Идемпотентно (IF NOT EXISTS).
 */
import postgres from 'postgres';

interface IndexSpec {
  name: string;
  table: string;
  /** Тело определения БЕЗ CREATE INDEX ... — то, что идёт после имени таблицы. */
  columns: string;
}

// Зеркало 0071_perf_indexes.sql, 0093_refresh_session_idx.sql и
// 0154_bundle_root_and_s3_key_idx.sql. При правке — синхронизировать
// соответствующий файл миграции.
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
  // 0093: живые токены сессии. Частичный — отозванные строки (почти весь объём
  // таблицы) в индекс не попадают. Строить CONCURRENTLY здесь особенно важно:
  // refresh_tokens в горячем пути логина, обычный CREATE INDEX остановил бы
  // выдачу токенов на время построения.
  {
    name: 'refresh_tokens_session_active_idx',
    table: 'refresh_tokens',
    columns: '("session_id") WHERE "revoked_at" IS NULL',
  },
  // 0154: «машина» — корневой пакет загрузки. Предикат видимости планшета,
  // счётчик документов машины и бампы ревизии соединяют пакеты условием
  // coalesce(parent_bundle_id, id) = root.id; без индекса на это выражение
  // каждая проверка перебирала таблицу пакетов целиком (сверка АЛИЯ — 34 с).
  // Выражение обязано БУКВАЛЬНО совпадать с запросами, иначе индекс не возьмут.
  {
    name: 'source_bundles_root_idx',
    table: 'source_bundles',
    columns: '((coalesce("parent_bundle_id", "id")))',
  },
  // 0154: «есть ли документ у принятого файла» — поиск вложения по ключу S3.
  {
    name: 'source_document_attachments_s3_key_idx',
    table: 'source_document_attachments',
    columns: '("s3_key")',
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
    // Ограничиваем ожидание конфликтующих локов: при затыке не висим бесконечно,
    // а падаем с ошибкой.
    //
    // Пять минут, а не секунды. CONCURRENTLY в конце ждёт, пока завершатся ВСЕ
    // запросы, начатые раньше него, и это ожидание тоже идёт через блокировку,
    // то есть под lock_timeout. Сверка планшета до появления индексов 0154
    // длится до 35 с, и планшеты запускают её постоянно: с прежними 10 с
    // построение падало бы почти наверняка, оставляя INVALID-индекс.
    //
    // Долгое ожидание здесь безопасно: CONCURRENTLY держит SHARE UPDATE
    // EXCLUSIVE, а с ним конфликтуют только DDL и VACUUM/ANALYZE той же таблицы.
    // Чтение и запись планшетов и портала идут как обычно.
    await sql.unsafe(`SET lock_timeout = '5min'`);

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
    }

    // ANALYZE по ВСЕМ таблицам списка, а не только по тем, где индекс построен в
    // этом прогоне. Иначе дыра: первый прогон построил индекс и упал на
    // следующем, до ANALYZE не дойдя; повторный прогон этот индекс пропускает
    // как готовый — и его таблица осталась бы без свежей статистики. Для индекса
    // по ВЫРАЖЕНИЮ это существенно: статистику выражения собирает только
    // ANALYZE, и без неё планировщик может не выбрать быстрый план.
    //
    // ANALYZE не блокирует ни чтение, ни запись; таблицы небольшие — секунды.
    const tablesToAnalyze = [...new Set(INDEXES.map((idx) => idx.table))];
    for (const table of tablesToAnalyze) {
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
  // Сбой посреди CREATE INDEX CONCURRENTLY оставляет индекс с тем же именем в
  // состоянии INVALID: имя занято, а планировщик его не использует. Повторный
  // запуск это чинит — такой индекс удаляется и строится заново (см. цикл выше).
  // Деплой до успешного прогона не запускать: миграция со стражем валидности
  // всё равно остановится на нём.
  console.error(
    '[create-indexes] СТОП: индекс мог остаться INVALID. Перезапустите этот скрипт — ' +
      'он удалит и построит индекс заново. Деплой до успешного прогона не запускать.',
  );
  process.exit(1);
});
