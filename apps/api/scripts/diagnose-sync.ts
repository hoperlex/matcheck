/**
 * Read-only диагностика рассинхронов приёмок/отгрузок между планшетом и порталом.
 * НИЧЕГО не пишет и не меняет — только SELECT. Безопасно запускать на проде.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/diagnose-sync.ts            # глобальный аудит
 *   pnpm --filter @matcheck/api tsx scripts/diagnose-sync.ts --site "ДОМ 56"
 *   pnpm --filter @matcheck/api tsx scripts/diagnose-sync.ts --site "ЖК Алия" --days 14
 *
 * Что показывает:
 *   1. «Финальный статус без позиций» — приёмки/отгрузки в filled/shipped/
 *      confirmed_mol, у которых НЕТ ни одной позиции. Это след частичной записи
 *      (баг отсутствия транзакции в upsert; устранён, скрипт помогает найти
 *      исторические следы).
 *   2. «Soft-deleted» — записи с pending_deletion_at: видны в мобильном /sync,
 *      но скрыты на портале (рассинхрон «на планшете есть, на портале нет»).
 *   3. С --site: полный список операций объекта за период с ключевыми полями —
 *      чтобы по «дом56»-кейсу глазами сверить, ЕСТЬ ли запись на сервере вообще,
 *      есть ли позиции, какой статус и siteId.
 *
 * Важно про дом56: если конкретной приёмки тут НЕТ, а на планшете она в архиве —
 * значит она не доехала до сервера (push-потеря). Это лечится мобильным этапом
 * (неудаляемая очередь + сверка), а не сервером.
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

const siteArg = argValue('--site');
const days = Number(argValue('--days') ?? '7');

const sql = postgres(url, { max: 1 });

function table(rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('  (пусто)');
    return;
  }
  console.table(rows.map((r) => ({ ...r })));
}

async function main(): Promise<void> {
  console.log('=== 1. Финальный статус БЕЗ позиций (след частичной записи) ===');
  const noItemsDeliveries = await sql`
    SELECT 'delivery' AS kind, d.display_id AS "displayId", st.code AS status,
           s.name AS site, d.pending_deletion_at AS "pendingDeletion",
           to_char(d.created_at, 'YYYY-MM-DD HH24:MI') AS created
    FROM deliveries d
    JOIN statuses st ON st.id = d.status_id
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE st.code IN ('filled', 'confirmed_mol')
      AND NOT EXISTS (SELECT 1 FROM delivery_items di WHERE di.delivery_id = d.id)
    ORDER BY d.created_at DESC
    LIMIT 100`;
  const noItemsShipments = await sql`
    SELECT 'shipment' AS kind, sh.display_id AS "displayId", st.code AS status,
           s.name AS site, sh.pending_deletion_at AS "pendingDeletion",
           to_char(sh.created_at, 'YYYY-MM-DD HH24:MI') AS created
    FROM shipments sh
    JOIN statuses st ON st.id = sh.status_id
    LEFT JOIN sites s ON s.id = sh.site_id
    WHERE st.code IN ('shipped', 'confirmed_mol')
      AND NOT EXISTS (SELECT 1 FROM shipment_items si WHERE si.shipment_id = sh.id)
    ORDER BY sh.created_at DESC
    LIMIT 100`;
  table([...noItemsDeliveries, ...noItemsShipments]);

  console.log(`\n=== 2. Soft-deleted за последние ${days} дн. (видно на мобильном, скрыто на портале) ===`);
  const softDeleted = await sql`
    SELECT 'delivery' AS kind, d.display_id AS "displayId", s.name AS site,
           to_char(d.pending_deletion_at, 'YYYY-MM-DD HH24:MI') AS "deletedAt"
    FROM deliveries d LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.pending_deletion_at IS NOT NULL
      AND d.pending_deletion_at >= now() - (${days} || ' days')::interval
    UNION ALL
    SELECT 'shipment' AS kind, sh.display_id AS "displayId", s.name AS site,
           to_char(sh.pending_deletion_at, 'YYYY-MM-DD HH24:MI') AS "deletedAt"
    FROM shipments sh LEFT JOIN sites s ON s.id = sh.site_id
    WHERE sh.pending_deletion_at IS NOT NULL
      AND sh.pending_deletion_at >= now() - (${days} || ' days')::interval
    ORDER BY "deletedAt" DESC
    LIMIT 100`;
  table(softDeleted);

  if (siteArg) {
    console.log(`\n=== 3. Все операции объекта "${siteArg}" за ${days} дн. (что РЕАЛЬНО есть на сервере) ===`);
    const bySite = await sql`
      SELECT 'delivery' AS kind, d.display_id AS "displayId", st.code AS status,
             (SELECT count(*)::int FROM delivery_items di WHERE di.delivery_id = d.id) AS items,
             d.pending_deletion_at IS NOT NULL AS "softDeleted",
             to_char(d.created_at, 'YYYY-MM-DD HH24:MI') AS created
      FROM deliveries d
      JOIN statuses st ON st.id = d.status_id
      JOIN sites s ON s.id = d.site_id
      WHERE (s.name ILIKE ${'%' + siteArg + '%'} OR s.code = ${siteArg})
        AND d.created_at >= now() - (${days} || ' days')::interval
      UNION ALL
      SELECT 'shipment' AS kind, sh.display_id AS "displayId", st.code AS status,
             (SELECT count(*)::int FROM shipment_items si WHERE si.shipment_id = sh.id) AS items,
             sh.pending_deletion_at IS NOT NULL AS "softDeleted",
             to_char(sh.created_at, 'YYYY-MM-DD HH24:MI') AS created
      FROM shipments sh
      JOIN statuses st ON st.id = sh.status_id
      JOIN sites s ON s.id = sh.site_id
      WHERE (s.name ILIKE ${'%' + siteArg + '%'} OR s.code = ${siteArg})
        AND sh.created_at >= now() - (${days} || ' days')::interval
      ORDER BY created DESC
      LIMIT 500`;
    table(bySite);
  } else {
    console.log('\n(подсказка: добавь --site "ИМЯ ОБЪЕКТА" для детального списка по объекту, например дом56)');
  }
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error('Ошибка диагностики:', err instanceof Error ? err.message : err);
    await sql.end();
    process.exit(1);
  });
