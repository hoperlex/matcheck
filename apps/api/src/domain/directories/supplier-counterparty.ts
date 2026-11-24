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
//   0. у записи справочника нет ИНН (или в графе ИНН больше 12 цифр — там ОГРН
//      либо ИНН с КПП) — служебная строка с ИНН-заглушкой «0000…», найденная
//      или заведённая по ссылке supplier_directory_id на эту запись
//      (resolveWithoutInn). Ни имя, ни чужие строки здесь не участвуют;
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
//
// До 24.11 в шаге 0 заводилась строка с ИНН «0». Место «ИНН без КПП» у «0»
// одно на всю таблицу, и с 21.10, когда его заняла «СК "ЭСТ"», выбор любого
// поставщика без ИНН отвечал 500 (приёмка 27099). «ИНН» из 13+ цифр падал на
// varchar(12) всегда.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { counterparties, deliveries, shipments, suppliers } from '../../db/schema.js';
import {
  operationalNameClose,
  operationalNameMatches,
  pickOperationalCounterparty,
} from './operational-pick.js';
import { generatePlaceholderInn } from './placeholder-inn.js';

export type SupplierDirectoryEntry = {
  /** id записи «Поставщиков» — ключ служебной строки поставщика без ИНН. */
  id: string;
  inn: string | null;
  name: string;
  aliases?: readonly string[] | null;
};

type Log = { info: (obj: object, msg: string) => void };

export type SupplierCounterpartyResult =
  | { kind: 'ok'; id: string }
  /** Место «ИНН без КПП» занято строкой с другим именем — выбор не выполнен. */
  | { kind: 'inn_taken'; inn: string; operationalName: string }
  /** Запись справочника удалили (склейка или откат импорта), пока её выбирали. */
  | { kind: 'directory_gone' };

export async function resolveSupplierCounterparty(
  db: Db,
  src: SupplierDirectoryEntry,
  log: Log,
): Promise<SupplierCounterpartyResult | null> {
  const innDigits = (src.inn ?? '').replace(/\D+/g, '');
  const name = src.name.trim();
  const directory = { name, aliases: src.aliases ?? [] };

  // Без ИНН сопоставлять по ИНН не с чем, по имени — опасно (АО и ООО
  // «МАСТЕР» — разные юрлица). Больше 12 цифр — не ИНН и не влезет в varchar(12).
  if (innDigits.length === 0 || innDigits.length > 12) {
    return resolveWithoutInn(db, src.id, name);
  }

  const sameInn = await db.select().from(counterparties).where(eq(counterparties.inn, innDigits));
  if (sameInn.length === 0) return ok(await insertSupplier(db, innDigits, name));

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
  if (!slot) return ok(await insertSupplier(db, innDigits, name));

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
 * Два одновременных выбора одного поставщика: второй упрётся в
 * counterparty_inn_unique (одна строка без КПП на ИНН) и вместо 500 получит
 * строку, которую только что завёл первый.
 */
async function insertSupplier(db: Db, inn: string, name: string): Promise<{ id: string } | null> {
  const values = { inn, kpp: null, name, isSupplier: true, isCustomer: false };
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

/** Сколько раз пробовать новую заглушку, если случайно совпала с занятой. */
const PLACEHOLDER_ATTEMPTS = 3;

/**
 * Служебная строка поставщика без ИНН: одна на запись справочника, найденная
 * по ссылке supplier_directory_id.
 *
 * FOR UPDATE строки suppliers — ключ сериализации. Два одновременных выбора
 * одной записи (приёмка и отгрузка) иначе оба не нашли бы строку и завели бы по
 * своей: случайные заглушки между собой не конфликтуют. Склейка и откат
 * импорта справочников (apply.ts, revert.ts) берут ту же строку FOR UPDATE до
 * переноса ссылок и удаления записи, поэтому связь не теряется ни в одном
 * порядке. Порядок блокировок у всех — suppliers, затем counterparties.
 *
 * Запись удалена, пока её выбирали, — `directory_gone`: маршрут отвечает 404,
 * человек выбирает заново из обновлённого списка.
 */
async function resolveWithoutInn(
  db: Db,
  directoryId: string,
  name: string,
): Promise<SupplierCounterpartyResult | null> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.id, directoryId))
      .for('update');
    if (!entry) return { kind: 'directory_gone' };

    // После склейки на запись может ссылаться несколько строк — берём старую.
    const [existing] = await tx
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.supplierDirectoryId, directoryId))
      .orderBy(asc(counterparties.createdAt), asc(counterparties.id))
      .limit(1);
    if (existing) return { kind: 'ok', id: existing.id };

    for (let attempt = 0; attempt < PLACEHOLDER_ATTEMPTS; attempt += 1) {
      const [created] = await tx
        .insert(counterparties)
        .values({
          inn: generatePlaceholderInn(),
          kpp: null,
          name,
          isSupplier: true,
          isCustomer: false,
          supplierDirectoryId: directoryId,
        })
        .onConflictDoNothing()
        .returning({ id: counterparties.id });
      if (created) return { kind: 'ok', id: created.id };
    }
    return null;
  });
}
