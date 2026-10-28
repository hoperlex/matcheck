// Операционная строка `counterparties` для поставщика, выбранного из
// «Поставщиков» в приёмке или отгрузке без документа
// (PATCH /deliveries|shipments/:id/supplier-from-directory).
//
// Раньше маршруты брали строку с тем же ИНН через LIMIT 1 без порядка. Под ИНН
// бывает несколько строк — подразделения и мусор распознавания, где модель
// взяла ИНН одной стороны и имя другой. 28.10 в приёмке 22204 выбрали
// «ООО "ВСЕИНСТРУМЕНТЫ.РУ"» (ИНН 7722753969), а записался «ЭСКАЛИФТ»: под этим
// ИНН лежат пять покупателей с чужими именами.
//
// Порядок:
//   1. строка с именем как в справочнике (pickOperationalCounterparty);
//   2. нет такой и место «ИНН без КПП» свободно — заводим строку с именем из
//      справочника;
//   3. место занято строкой с другим именем — берём лучшую по тому же порядку,
//      как раньше. Чужое имя тогда остаётся (принятый остаток, см. лог
//      supplier_from_directory_foreign_name): лечится чисткой операционной
//      таблицы, а не выбором.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { counterparties, deliveries, shipments } from '../../db/schema.js';
import { operationalNameMatches, pickOperationalCounterparty } from './operational-pick.js';

export type SupplierDirectoryEntry = {
  inn: string | null;
  name: string;
  aliases?: readonly string[] | null;
};

type Log = { info: (obj: object, msg: string) => void };

export async function resolveSupplierCounterparty(
  db: Db,
  src: SupplierDirectoryEntry,
  log: Log,
): Promise<{ id: string } | null> {
  const innDigits = (src.inn ?? '').replace(/\D+/g, '');
  const name = src.name.trim();
  const directory = { name, aliases: src.aliases ?? [] };

  // Без ИНН сопоставлять не по чему — прежняя ветка создания.
  if (innDigits.length === 0) return insertSupplier(db, '0', name);

  const sameInn = await db.select().from(counterparties).where(eq(counterparties.inn, innDigits));
  if (sameInn.length === 0) return insertSupplier(db, innDigits, name, { onConflict: 'reread' });

  const usage =
    sameInn.length > 1
      ? await supplierUsage(
          db,
          sameInn.map((r) => r.id),
        )
      : new Map();
  const picked = pickOperationalCounterparty(sameInn, directory, usage);
  if (picked && operationalNameMatches(picked.name, directory)) return { id: picked.id };

  if (!sameInn.some((r) => r.kpp === null)) {
    const created = await insertSupplier(db, innDigits, name, { onConflict: 'reread' });
    if (created) return created;
  }

  if (!picked) return null;
  log.info(
    {
      inn: innDigits,
      directoryName: name,
      operationalName: picked.name,
      counterpartyId: picked.id,
    },
    'supplier_from_directory_foreign_name',
  );
  return { id: picked.id };
}

/** Сколько приёмок и отгрузок ссылается на строку как на поставщика. */
async function supplierUsage(db: Db, ids: string[]): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  const [byDelivery, byShipment] = await Promise.all([
    db
      .select({ id: deliveries.supplierId, n: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(inArray(deliveries.supplierId, ids))
      .groupBy(deliveries.supplierId),
    db
      .select({ id: shipments.supplierId, n: sql<number>`count(*)::int` })
      .from(shipments)
      .where(inArray(shipments.supplierId, ids))
      .groupBy(shipments.supplierId),
  ]);
  for (const c of [...byDelivery, ...byShipment]) {
    if (c.id) usage.set(c.id, (usage.get(c.id) ?? 0) + Number(c.n));
  }
  return usage;
}

/**
 * Служебная строка поставщика: ИНН без КПП, имя из справочника.
 *
 * `reread` — два одновременных выбора одного поставщика: второй упрётся в
 * counterparty_inn_unique (одна строка без КПП на ИНН) и вместо 500 получит
 * строку, которую только что завёл первый.
 */
async function insertSupplier(
  db: Db,
  inn: string,
  name: string,
  opts: { onConflict?: 'reread' } = {},
): Promise<{ id: string } | null> {
  const values = { inn, kpp: null, name, isSupplier: true, isCustomer: false };
  if (opts.onConflict !== 'reread') {
    const [created] = await db
      .insert(counterparties)
      .values(values)
      .returning({ id: counterparties.id });
    return created ?? null;
  }
  const [created] = await db
    .insert(counterparties)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: counterparties.id });
  if (created) return created;
  const [existing] = await db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.inn, inn), isNull(counterparties.kpp)))
    .limit(1);
  return existing ?? null;
}
