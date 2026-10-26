// Покупатель совпал с поставщиком (рубильник PARTY_ROLES_CHECK).
//
// Организация не может купить сама у себя, поэтому такой документ уже
// распознан неверно — вопрос только в том, какая из сторон ошибочна. Бывает
// по-разному, и данные это показывают:
//   - приёмка 21544: фирменная «НАКЛАДНАЯ 16» ООО «ИМПЕРИЯ» ушла в УПД-промпт,
//     и модель записала грузоотправителя покупателем — ошибочен покупатель;
//   - СТРОЙСЕРВИС, ФАСТ ГРУПП, ИНСТРАКТ — подрядчики; в их документах модель
//     переносит покупателя в поставщика — ошибочен поставщик.
// Автоматически сбрасываем только покупателя и только когда ответ однозначен:
// организация не своя и не подрядчик, ИНН сторон не спорят, и по истории
// документов она — поставщик (≥ 5 раз и вдвое чаще, чем покупатель или
// грузополучатель). Всё прочее — пометка человеку, данные не трогаются.
//
// Решатель — чистые функции; ветки перечислены в test/party-roles.test.ts.
// Загрузчик истории вызывается только когда стороны совпали (≈4–5 документов
// в день), поэтому может позволить себе подсчёт по всей таблице.

import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { UpdValidation, UpdWarning } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { customerCounterparties, sourceDocuments, suppliers } from '../../db/schema.js';
import { companyKey, formsCompatible } from '../directories/names.js';
import { normalizePartyName, type RawParty } from './party-directory-guard.js';
import { normalizeInn } from './resolve-contractor.js';
import { loadOwnInns } from './supplier-inn-check.js';

export type PartyRolesMode = 'off' | 'shadow' | 'on';

/** Сколько раз организация должна быть поставщиком, чтобы сбросить покупателя. */
export const DROP_MIN_AS_SUPPLIER = 5;
/** Во сколько раз чаще поставщиком, чем покупателем и грузополучателем вместе. */
export const DROP_SUPPLIER_RATIO = 2;
/** Окно истории ролей. */
export const ROLE_HISTORY_DAYS = 180;

function innDigits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

/**
 * Одна ли это организация — поставщик и покупатель документа.
 *
 * Имя сравнивается без формы собственности, кавычек и регистра (companyKey),
 * формы не должны противоречить (ООО и АО с одним именем — разные юрлица).
 * Два валидных разных ИНН — разные организации, сколько бы ни совпадали имена.
 * Случай «ИНН одинаковые, имена разные» сюда не относится: это ИНН соседней
 * стороны, а не одна организация на двух местах.
 */
export function sameParty(
  supplier: RawParty | null | undefined,
  buyer: RawParty | null | undefined,
): boolean {
  const supplierName = normalizePartyName(supplier?.name);
  const buyerName = normalizePartyName(buyer?.name);
  if (!supplierName || !buyerName) return false;
  const key = companyKey(supplierName);
  if (!key || key !== companyKey(buyerName)) return false;
  if (!formsCompatible(supplierName, buyerName)) return false;
  const supplierInn = normalizeInn(supplier?.inn);
  const buyerInn = normalizeInn(buyer?.inn);
  return !(supplierInn && buyerInn && supplierInn !== buyerInn);
}

/** Что известно об организации, которая стоит и поставщиком, и покупателем. */
export type PartyRoleStats = {
  /** ИНН организации: из документа или единственный одноимённый в справочниках. */
  inn: string | null;
  innSource: 'document' | 'directory' | null;
  /** ИНН сторон не спорят: у обеих пусто или одинаковые цифры. */
  innsAgree: boolean;
  isOwn: boolean;
  isContractor: boolean;
  /** Сколько документов за окно она была поставщиком (кроме этого). */
  asSupplier: number;
  /** Сколько — покупателем или грузополучателем (кроме этого). */
  asBuyerOrConsignee: number;
};

export type SamePartyDecision =
  | { kind: 'drop_buyer' }
  | {
      kind: 'flag';
      reason: 'own' | 'contractor' | 'no_inn' | 'inn_disagree' | 'history';
    };

/**
 * Решение по совпавшим сторонам. Порядок проверок — от того, что данные
 * трогать запрещает, к единственной ветке, которая их меняет.
 */
export function decideSameParty(stats: PartyRoleStats): SamePartyDecision {
  // Своя организация в графе поставщика — ошибка поставщика, не покупателя.
  if (stats.isOwn) return { kind: 'flag', reason: 'own' };
  // Подрядчик в документах — покупатель; ошибочен скорее поставщик.
  if (stats.isContractor) return { kind: 'flag', reason: 'contractor' };
  if (!stats.inn) return { kind: 'flag', reason: 'no_inn' };
  // ИНН есть только у одной стороны или они разные невалидные — это могут
  // быть две одноимённые организации.
  if (!stats.innsAgree) return { kind: 'flag', reason: 'inn_disagree' };
  const supplierSide =
    stats.asSupplier >= DROP_MIN_AS_SUPPLIER &&
    stats.asSupplier >= DROP_SUPPLIER_RATIO * stats.asBuyerOrConsignee;
  return supplierSide ? { kind: 'drop_buyer' } : { kind: 'flag', reason: 'history' };
}

/** Записи справочника для поиска ИНН по имени: имя, алиасы, ИНН. */
type NamedInn = { name: string; aliases: string[] | null; inn: string | null };

function namesOf(r: NamedInn): string[] {
  return [r.name, ...(r.aliases ?? [])];
}

/**
 * ИНН организации по имени — единственный валидный среди одноимённых записей.
 * Несколько разных ИНН с тем же именем — не знаем, null.
 */
export function innByName(name: string, rows: readonly NamedInn[]): string | null {
  const key = companyKey(name);
  if (!key) return null;
  const found = new Set<string>();
  for (const r of rows) {
    const inn = normalizeInn(r.inn);
    if (!inn) continue;
    if (namesOf(r).some((n) => companyKey(n) === key && formsCompatible(name, n))) found.add(inn);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Подрядчик ли организация — по ИНН или по имени в «Контрагентах». */
export function isContractorParty(
  name: string,
  inn: string | null,
  contractors: readonly NamedInn[],
): boolean {
  const key = companyKey(name);
  return contractors.some(
    (c) =>
      (inn !== null && normalizeInn(c.inn) === inn) ||
      (key !== '' && namesOf(c).some((n) => companyKey(n) === key && formsCompatible(name, n))),
  );
}

/**
 * Собрать всё, что нужно decideSameParty. Вызывать только когда sameParty
 * вернул true: справочник поставщиков читается целиком, если ИНН в документе
 * нет, а история ролей — подсчётом по таблице документов.
 */
export async function loadPartyRoleStats(
  db: Db,
  supplier: RawParty,
  buyer: RawParty,
  selfId: string,
): Promise<PartyRoleStats> {
  const name = normalizePartyName(supplier.name) ?? normalizePartyName(buyer.name) ?? '';
  const supplierDigits = innDigits(supplier.inn);
  const buyerDigits = innDigits(buyer.inn);
  const innsAgree = supplierDigits === buyerDigits;

  const [ownInns, contractors] = await Promise.all([
    loadOwnInns(db),
    db
      .select({
        name: customerCounterparties.name,
        aliases: customerCounterparties.aliases,
        inn: customerCounterparties.inn,
      })
      .from(customerCounterparties),
  ]);

  let inn = normalizeInn(supplier.inn) ?? normalizeInn(buyer.inn);
  let innSource: PartyRoleStats['innSource'] = inn ? 'document' : null;
  if (!inn && name) {
    const directory = await db
      .select({ name: suppliers.name, aliases: suppliers.aliases, inn: suppliers.inn })
      .from(suppliers);
    inn = innByName(name, [...directory, ...contractors]);
    innSource = inn ? 'directory' : null;
  }

  let asSupplier = 0;
  let asBuyerOrConsignee = 0;
  if (inn) {
    const since = sql`now() - make_interval(days => ${ROLE_HISTORY_DAYS})`;
    const notTechnical = sql`not coalesce(${sourceDocuments.isTechnical}, false)`;
    const [s] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sourceDocuments)
      .innerJoin(suppliers, eq(suppliers.id, sourceDocuments.supplierDirectoryId))
      .where(
        and(
          sql`regexp_replace(coalesce(${suppliers.inn}, ''), '\\D', '', 'g') = ${inn}`,
          gt(sourceDocuments.createdAt, since),
          ne(sourceDocuments.id, selfId),
          notTechnical,
        ),
      );
    const [b] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sourceDocuments)
      .where(
        and(
          sql`(regexp_replace(coalesce(${sourceDocuments.buyerInnRaw}, ''), '\\D', '', 'g') = ${inn}
            or regexp_replace(coalesce(${sourceDocuments.consigneeInnRaw}, ''), '\\D', '', 'g') = ${inn})`,
          gt(sourceDocuments.createdAt, since),
          ne(sourceDocuments.id, selfId),
          notTechnical,
        ),
      );
    asSupplier = s?.n ?? 0;
    asBuyerOrConsignee = b?.n ?? 0;
  }

  return {
    inn,
    innSource,
    innsAgree,
    isOwn: inn !== null && ownInns.has(inn),
    isContractor: name !== '' && isContractorParty(name, inn, contractors),
    asSupplier,
    asBuyerOrConsignee,
  };
}

export const PARTY_ROLES_WARNING = 'buyer_same_as_supplier' as const;

/**
 * Снять прежнюю пометку и, если нужно, поставить актуальную.
 *
 * Снимается во ВСЕХ режимах: пометка устойчивая (переносится из прошлого
 * снимка независимо от флага), и без снятия выключенный рубильник оставил бы
 * её навсегда. Ставится только когда `flag` — вызывающий передаёт его лишь в
 * режиме on. Нечего снимать и нечего ставить — тот же объект: для документов
 * без пометки это строгий no-op.
 */
export function withPartyRolesWarning(validation: UpdValidation, flag: boolean): UpdValidation {
  const all = validation.warnings ?? [];
  const kept = all.filter((w) => w.name !== PARTY_ROLES_WARNING);
  const stale = kept.length !== all.length;
  if (!flag) return stale ? { ...validation, warnings: kept } : validation;
  const warning: UpdWarning = { name: PARTY_ROLES_WARNING, scope: 'document' };
  return { ...validation, warnings: [...kept, warning] };
}
