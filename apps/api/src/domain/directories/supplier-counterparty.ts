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
//   3. место занято строкой с другим написанием той же организации (порядок
//      слов, опечатка в 1–2 знака — sameCompanySpelling) — берём её, как раньше;
//   4. место занято строкой с действительно другим именем — ОТКАЗ (`inn_taken`),
//      маршрут отвечает 409 с именем, которое там записано.
//
// До 17.11 в шаге 4 молча бралась чужая строка: приёмки 24888, 24994, 25616 и
// 25619 вместо выбранной «ООО "ВЫСОТА"» получили «ИП Сатаневский», потому что
// распознавание накладных завело грузополучателя с ИНН «Высоты». Портал при
// этом писал «Поставщик обновлён». Неверное имя в приёмке хуже явного отказа:
// отказ виден сразу, а такое место лечится только чисткой операционной таблицы.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { counterparties, deliveries, shipments } from '../../db/schema.js';
import {
  operationalNameClose,
  operationalNameMatches,
  pickOperationalCounterparty,
} from './operational-pick.js';

export type SupplierDirectoryEntry = {
  inn: string | null;
  name: string;
  aliases?: readonly string[] | null;
};

type Log = { info: (obj: object, msg: string) => void };

export type SupplierCounterpartyResult =
  | { kind: 'ok'; id: string }
  /** Место «ИНН без КПП» занято строкой с другим именем — выбор не выполнен. */
  | { kind: 'inn_taken'; inn: string; operationalName: string };

export async function resolveSupplierCounterparty(
  db: Db,
  src: SupplierDirectoryEntry,
  log: Log,
): Promise<SupplierCounterpartyResult | null> {
  const innDigits = (src.inn ?? '').replace(/\D+/g, '');
  const name = src.name.trim();
  const directory = { name, aliases: src.aliases ?? [] };

  // Без ИНН сопоставлять не по чему — прежняя ветка создания.
  if (innDigits.length === 0) return ok(await insertSupplier(db, '0', name));

  const sameInn = await db.select().from(counterparties).where(eq(counterparties.inn, innDigits));
  if (sameInn.length === 0) {
    return ok(await insertSupplier(db, innDigits, name, { onConflict: 'reread' }));
  }

  const usage =
    sameInn.length > 1
      ? await supplierUsage(
          db,
          sameInn.map((r) => r.id),
        )
      : new Map();
  const picked = pickOperationalCounterparty(sameInn, directory, usage);
  if (picked && operationalNameMatches(picked.name, directory))
    return { kind: 'ok', id: picked.id };

  const slot = sameInn.find((r) => r.kpp === null);
  if (!slot) return ok(await insertSupplier(db, innDigits, name, { onConflict: 'reread' }));

  // Отказываем только при действительно чужом имени: «КЕРАМЕС ГРУП» вместо
  // «КЕРАМЕС ГРУПП» — та же организация, и выбор проходил всегда.
  const refused = !operationalNameClose(slot.name, directory);
  log.info(
    {
      inn: innDigits,
      directoryName: name,
      operationalName: slot.name,
      counterpartyId: slot.id,
      refused,
    },
    'supplier_from_directory_foreign_name',
  );
  if (!refused) return { kind: 'ok', id: slot.id };
  return { kind: 'inn_taken', inn: innDigits, operationalName: slot.name };
}

function ok(row: { id: string } | null): SupplierCounterpartyResult | null {
  return row ? { kind: 'ok', id: row.id } : null;
}

/** Текст отказа для портала: что записано под ИНН и что делать. */
export function innTakenMessage(r: { inn: string; operationalName: string }): string {
  return (
    `Под ИНН ${r.inn} в базе записана другая организация — «${r.operationalName}». ` +
    'Поставщик не изменён, сообщите администратору.'
  );
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
