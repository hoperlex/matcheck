/**
 * Поиск или заведение контрагента по реквизитам из документа.
 *
 * Две вещи, которых не делал прежний помощник в поллере.
 *
 * 1. ГОНКА. Вставка шла без `onConflict`, и два документа одного нового
 *    поставщика, разобранные подряд, давали 23505: первый успевал вставить, а
 *    второй падал на уникальном индексе. Проявлялось бы это ровно тогда, когда
 *    с ящиком впервые начинают работать, — то есть в первый же день.
 *
 * 2. РОЛИ. Найденному контрагенту он просто возвращал id. Организация,
 *    заведённая когда-то как заказчик, во входящем УПД так и не получала
 *    `is_supplier = true` — и выпадала из отборов по поставщикам, хотя товар
 *    пришёл именно от неё.
 *
 * Индексов два и оба частичные: `(inn, kpp)` при заполненном КПП и `(inn)` при
 * пустом. Поэтому и веток вставки две — набор колонок в `onConflict` обязан
 * точно совпадать с индексом, иначе PostgreSQL отвечает 42P10.
 */
import { and, eq, isNull, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { counterparties } from '../../db/schema.js';

export type PartyRef = { inn: string; kpp: string | null; name: string };
export type PartyRole = 'supplier' | 'customer';

export async function findOrCreateCounterparty(
  db: Db,
  party: PartyRef,
  role: PartyRole,
): Promise<string> {
  const wantSupplier = role === 'supplier';
  const wantCustomer = role === 'customer';

  const whereSame = party.kpp
    ? and(eq(counterparties.inn, party.inn), eq(counterparties.kpp, party.kpp))
    : and(eq(counterparties.inn, party.inn), isNull(counterparties.kpp));

  const [existing] = await db
    .select({
      id: counterparties.id,
      isSupplier: counterparties.isSupplier,
      isCustomer: counterparties.isCustomer,
    })
    .from(counterparties)
    .where(whereSame)
    .limit(1);

  if (existing) {
    // Роль добавляется, а не заменяется: одна и та же организация бывает и
    // поставщиком, и заказчиком, и снимать чужую пометку нельзя.
    const needsSupplier = wantSupplier && !existing.isSupplier;
    const needsCustomer = wantCustomer && !existing.isCustomer;
    if (needsSupplier || needsCustomer) {
      await db
        .update(counterparties)
        .set({
          ...(needsSupplier ? { isSupplier: true } : {}),
          ...(needsCustomer ? { isCustomer: true } : {}),
          updatedAt: new Date(),
        })
        .where(eq(counterparties.id, existing.id));
    }
    return existing.id;
  }

  const [created] = await db
    .insert(counterparties)
    .values({
      inn: party.inn,
      kpp: party.kpp,
      name: party.name,
      isSupplier: wantSupplier,
      isCustomer: wantCustomer,
    })
    .onConflictDoNothing({
      // Предикат обязан ТОЧНО повторять частичный индекс, иначе 42P10.
      target: party.kpp ? [counterparties.inn, counterparties.kpp] : [counterparties.inn],
      where: party.kpp
        ? drSql`${counterparties.kpp} is not null`
        : drSql`${counterparties.kpp} is null`,
    })
    .returning({ id: counterparties.id });

  if (created) return created.id;

  // Конфликт: пока мы разбирали документ, контрагента завёл кто-то другой.
  // Это не ошибка — перечитываем и продолжаем с его записью.
  const [raced] = await db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(whereSame)
    .limit(1);
  if (!raced) throw new Error(`Не удалось ни создать, ни найти контрагента ИНН ${party.inn}`);
  return raced.id;
}
