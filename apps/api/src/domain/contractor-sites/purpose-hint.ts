// Вид справочника «Контрагенты → Объекты и вид» для приёмки: какой признак
// подставить и что подсветить в карточке (domain/operations/delivery-purpose.ts).
//
// Получатель приёмки — операционная `counterparties`, ссылки на справочник у неё
// нет. Поэтому сначала находится ОРГАНИЗАЦИЯ, и только потом её пара с объектом:
//   1. точное совпадение по ИНН (normalizeInn: контрольные цифры, заглушки
//      отсечены) — если оно есть, имя не смотрим вообще;
//   2. иначе — имя или альтернативное название, только среди записей
//      справочника БЕЗ верного ИНН и только при единственном совпадении.
// Пара, скрытая вручную ('none'), даёт «вида нет»: тёзку мы в этом случае не
// ищем, и чужой вид её не подменит. Неоднозначность — тоже «вида нет».
// Правила from-directory (routes/counterparties.ts) сюда не переносятся: там
// обратное направление — из справочника в операционную таблицу.

import { and, eq, sql } from 'drizzle-orm';
import type { ContractorSiteKind } from '@matcheck/contracts';
import {
  counterparties,
  customerCounterparties,
  customerCounterpartySites,
  sites,
  SYSTEM_SITE_ID,
} from '../../db/schema.js';
import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';
import type { Executor } from './apply.js';
import { effectiveKind } from './card.js';

export type DirectorySiteKind = {
  kind: ContractorSiteKind;
  /** Вид указан вручную в карточке контрагента (иначе — из 1С). */
  manual: boolean;
  siteCode: string;
};

const nameKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/** Запись справочника «Контрагенты» для операционного подрядчика; null — нет или неоднозначно. */
export async function resolveDirectoryContractor(
  ex: Executor,
  contractorId: string,
): Promise<string | null> {
  const [op] = await ex
    .select({ inn: counterparties.inn, name: counterparties.name, aliases: counterparties.aliases })
    .from(counterparties)
    .where(eq(counterparties.id, contractorId))
    .limit(1);
  if (!op) return null;

  const inn = normalizeInn(op.inn);
  if (inn) {
    // ИНН в справочнике «грязный» (0055): отбираем по цифрам, проверяем как ИНН.
    const rows = await ex
      .select({ id: customerCounterparties.id, inn: customerCounterparties.inn })
      .from(customerCounterparties)
      .where(sql`regexp_replace(${customerCounterparties.inn}, '[^0-9]', '', 'g') = ${inn}`);
    const exact = rows.filter((r) => normalizeInn(r.inn) === inn);
    if (exact.length === 1) return exact[0]!.id;
    if (exact.length > 1) return null;
  }

  const keys = [...new Set([op.name, ...(op.aliases ?? [])].map(nameKey).filter(Boolean))];
  if (keys.length === 0) return null;
  const keyList = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = await ex
    .select({ id: customerCounterparties.id, inn: customerCounterparties.inn })
    .from(customerCounterparties)
    .where(
      sql`(lower(btrim(${customerCounterparties.name})) IN (${keyList})
           OR EXISTS (SELECT 1 FROM unnest(${customerCounterparties.aliases}) a
                       WHERE lower(btrim(a)) IN (${keyList})))`,
    );
  const withoutInn = rows.filter((r) => normalizeInn(r.inn) === null);
  return withoutInn.length === 1 ? withoutInn[0]!.id : null;
}

/** Действующий вид пары подрядчик × объект; null — получателя/объекта нет, пары нет или она скрыта. */
export async function directorySiteKindFor(
  ex: Executor,
  contractorId: string | null,
  siteId: string | null,
): Promise<DirectorySiteKind | null> {
  if (!contractorId || !siteId || siteId === SYSTEM_SITE_ID) return null;
  const ccId = await resolveDirectoryContractor(ex, contractorId);
  if (!ccId) return null;
  const [row] = await ex
    .select({
      onecKind: customerCounterpartySites.onecKind,
      manualKind: customerCounterpartySites.manualKind,
      siteCode: sites.code,
    })
    .from(customerCounterpartySites)
    .innerJoin(sites, eq(sites.id, customerCounterpartySites.siteId))
    .where(
      and(
        eq(customerCounterpartySites.customerCounterpartyId, ccId),
        eq(customerCounterpartySites.siteId, siteId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const kind = effectiveKind(row);
  if (!kind) return null;
  return { kind, manual: row.manualKind !== null, siteCode: row.siteCode };
}
