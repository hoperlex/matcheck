import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql as drSql } from 'drizzle-orm';
import { counterparties, customerCounterparties, deliveries } from '../db/schema.js';
import type { AuthUser } from '../plugins/auth.js';

// Скоупинг видимости по подрядчику (роль contractor). Аналог inspector_kpp→siteId,
// но по подрядчику: пользователь привязан к строке справочника
// customer_counterparties, которая разворачивается в операционные
// counterparties.id по нормализованному ИНН (один реальный подрядчик = один ИНН
// = несколько операционных строк-дублей). Тот же механизм, что у UI-фильтра
// «Подрядчик», поэтому область видимости роли и ручной фильтр дают один предикат.

/**
 * Directory-id (customer_counterparties) → операционные counterparties.id по
 * нормализованному ИНН. Пустой массив на входе или отсутствие совпадений по ИНН
 * → пустой результат (интерпретируется вызывающим как «ничего не видно»).
 * regexp_replace убирает всё, кроме цифр; пустой/нулевой ИНН отбрасывается,
 * чтобы разные контрагенты без ИНН не «склеились».
 */
export async function expandCustomerCounterpartyToOpIds(
  app: FastifyInstance,
  directoryIds: string[],
): Promise<string[]> {
  if (directoryIds.length === 0) return [];
  const rows = await app.db
    .select({ id: counterparties.id })
    .from(counterparties)
    .innerJoin(
      customerCounterparties,
      drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g')
          = regexp_replace(coalesce(${customerCounterparties.inn}, ''), '[^0-9]', '', 'g')`,
    )
    .where(
      and(
        inArray(customerCounterparties.id, directoryIds),
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') != ''`,
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') !~ '^0+$'`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Операционные counterparty-id, к которым привязан пользователь-подрядчик.
 * - null  → роль НЕ contractor: вызывающий пропускает скоупинг по подрядчику.
 * - []    → contractor без привязки (contractorCustomerId=null) ИЛИ его ИНН не
 *           совпал ни с одной операционной строкой: вызывающий пушит `false`
 *           (подрядчик видит пусто, как inspector без объекта).
 * - [...] → набор операционных id для фильтра.
 */
export async function resolveContractorOpIds(
  app: FastifyInstance,
  user: AuthUser | undefined,
): Promise<string[] | null> {
  if (!user || user.role !== 'contractor') return null;
  if (!user.contractorCustomerId) return [];
  return expandCustomerCounterpartyToOpIds(app, [user.contractorCustomerId]);
}

/**
 * Наследующий предикат видимости приёмки для подрядчика: приёмка «его», если её
 * contractor_id ∈ opIds, ЛИБО у приёмки contractor_id пуст, но привязанный
 * документ (УПД) имеет contractor_id ∈ opIds. Повторяет UI-фильтр «Подрядчик»
 * (deliveries.ts). Вызывать только при непустом opIds.
 */
export function deliveryContractorPredicate(opIds: string[]) {
  return drSql`(
    ${deliveries.contractorId} = ANY(${opIds}::uuid[])
    OR (
      ${deliveries.contractorId} IS NULL
      AND EXISTS (
        SELECT 1 FROM delivery_sources ds_c
        JOIN source_documents sd_c ON sd_c.id = ds_c.source_document_id
        WHERE ds_c.delivery_id = ${deliveries.id}
          AND sd_c.contractor_id = ANY(${opIds}::uuid[])
      )
    )
  )`;
}

/**
 * Видима ли конкретная приёмка подрядчику (для детального/файлового эндпоинта,
 * где предикат нельзя вшить в основной запрос). opIds — результат
 * resolveContractorOpIds; при пустом массиве всегда false.
 */
export async function deliveryVisibleToContractor(
  app: FastifyInstance,
  deliveryId: string,
  opIds: string[],
): Promise<boolean> {
  if (opIds.length === 0) return false;
  const [row] = await app.db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.id, deliveryId), deliveryContractorPredicate(opIds)))
    .limit(1);
  return !!row;
}
