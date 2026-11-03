// Группы поставщиков для выбора человеком: фильтр «Поставщик» в списках и окно
// выбора поставщика в карточке приёмки/отгрузки.
//
// Зачем. В справочнике у одной организации бывает по 40 записей: распознавание
// заводит новую строку на каждый неверно прочитанный ИНН («ТОРГОВЫЙ ДОМ
// "ТУЛА-СТАЛЬ"» рядом с BillHub-записью «ООО "ТД "ТУЛА-СТАЛЬ"»). Склеивать их в
// самом справочнике опасно: «корректный» ИНН дубля сам бывает чужим (ИНН СУ-10,
// ИНН подрядчика), — поэтому склейка 29.10 оставила их под ручные пары. Здесь
// они не склеиваются, а только показываются одной строкой: группа = одно имя.
//
// Правила (план 02.11, решение — склеивать по имени):
//   - ключ — companyKey (форма собственности, кавычки, регистр не важны) плюс
//     свёртка «ТОРГОВЫЙ ДОМ» → «ТД» и подобных сокращений;
//   - тёзки разводятся, только если записи BillHub дают ≥2 разных корректных
//     ИНН; остальное с тем же именем — одна группа-остаток. Без двух ИНН BillHub
//     одно имя — одна группа, даже при нескольких корректных ИНН (принятое
//     ограничение: так же выглядят кластеры ошибок распознавания);
//   - ключ без смысловой части («ООО», «ТК») ни с чем не склеивается.
//
// Фильтр по группе (expandSupplierFilterIds) зависит только от группы, а не от
// того, какой её участник передан: иначе выдача менялась бы от выбора строки.

import type { FastifyInstance } from 'fastify';
import { isNotNull, sql as drSql } from 'drizzle-orm';
import {
  counterparties,
  customerCounterparties,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import { isValidInnChecksum } from '../sourceDocuments/resolve-contractor.js';
import { loadOwnInns } from '../sourceDocuments/supplier-inn-check.js';
import { companyKey } from './names.js';

export type SupplierGroupRow = {
  id: string;
  name: string;
  inn: string;
  aliases: readonly string[];
  billhubId: string | null;
  createdAt: Date;
  /** Документов на записи — только для выбора основной записи. */
  docCount?: number;
};

export type SupplierGroupContext = {
  /** ИНН своей организации (edo_accounts) — не ИНН поставщика. */
  ownInns?: ReadonlySet<string>;
  /** ИНН «Контрагентов» (подрядчики и СУ-10) — тоже не ИНН поставщика. */
  contractorInns?: ReadonlySet<string>;
};

export type SupplierFilterGroup = {
  /** id основной записи: её пишет окно выбора, её id стоит в URL фильтра. */
  value: string;
  label: string;
  key: string;
  memberIds: string[];
  /** Ключи имён и алиасов участников — для проверки имени контрагента. */
  nameKeys: string[];
  /** ИНН участников; billhubCorrect — у записи BillHub и с верной контрольной суммой. */
  inns: { digits: string; billhubCorrect: boolean }[];
};

/**
 * ИНН для сопоставления в фильтре: только цифры, любой длины — одинаковые
 * опечатки (в том числе 11-значные) обязаны совпадать между собой. Пусто и
 * сплошные нули — «нет ИНН». Не путать с innDigits из names.ts: тот отбрасывает
 * всё, кроме 10 и 12 знаков.
 */
export function filterInn(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d === '' || /^0+$/.test(d) ? null : d;
}

/** Длина 10/12 и контрольная сумма. Нули отсекает filterInn: у них сумма сходится. */
export function isCorrectFilterInn(digits: string | null): boolean {
  return (
    digits !== null && (digits.length === 10 || digits.length === 12) && isValidInnChecksum(digits)
  );
}

// Длинные сначала: «СТРОИТЕЛЬНЫЙ ТОРГОВЫЙ ДОМ» не должен стать «СТРОИТЕЛЬНЫЙ ТД».
const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/(^| )СТРОИТЕЛЬНЫЙ ТОРГОВЫЙ ДОМ(?= |$)/gu, '$1СТД'],
  [/(^| )ТОРГОВЫЙ ДОМ(?= |$)/gu, '$1ТД'],
  [/(^| )СПЕЦИАЛИЗИРОВАННЫЙ ЗАСТРОЙЩИК(?= |$)/gu, '$1СЗ'],
  [/(^| )(?:ТОРГОВАЯ|ТРАНСПОРТНАЯ) КОМПАНИЯ(?= |$)/gu, '$1ТК'],
  [/(^| )СТРОИТЕЛЬНАЯ КОМПАНИЯ(?= |$)/gu, '$1СК'],
  [/(^| )ГРУППА КОМПАНИЙ(?= |$)/gu, '$1ГК'],
];
const ABBREVIATION_TOKENS = new Set(['СТД', 'ТД', 'СЗ', 'ТК', 'СК', 'ГК']);

/**
 * Ключ имени группы. Пустая строка — у имени нет смысловой части (только форма
 * собственности или сокращение): такую запись не с чем сравнивать.
 */
export function groupKey(name: string): string {
  let key = companyKey(name);
  for (const [re, to] of ABBREVIATIONS) key = key.replace(re, to);
  const parts = key.split(' ').filter(Boolean);
  return parts.every((t) => ABBREVIATION_TOKENS.has(t)) ? '' : parts.join(' ');
}

type Member = SupplierGroupRow & { digits: string | null; correct: boolean; foreign: boolean };

// Основная запись: BillHub с верным ИНН → BillHub → верный ИНН не СУ-10 и не
// подрядчика → верный ИНН → больше документов → старше → id. Порядок полный,
// иначе основная запись зависела бы от порядка строк в выборке.
function compareMembers(a: Member, b: Member): number {
  const rank = (m: Member): number[] => [
    m.billhubId !== null && m.correct ? 0 : 1,
    m.billhubId !== null ? 0 : 1,
    m.correct && !m.foreign ? 0 : 1,
    m.correct ? 0 : 1,
    -(m.docCount ?? 0),
    m.createdAt.getTime(),
  ];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function makeGroup(
  key: string,
  members: Member[],
  label: (rep: Member) => string,
): SupplierFilterGroup {
  const sorted = [...members].sort(compareMembers);
  const rep = sorted[0]!;
  const nameKeys = new Set<string>();
  const inns = new Map<string, boolean>();
  for (const m of sorted) {
    for (const n of [m.name, ...m.aliases]) {
      const k = groupKey(n);
      if (k) nameKeys.add(k);
    }
    if (m.digits) {
      const billhubCorrect = m.billhubId !== null && m.correct;
      inns.set(m.digits, (inns.get(m.digits) ?? false) || billhubCorrect);
    }
  }
  return {
    value: rep.id,
    label: label(rep),
    key,
    memberIds: sorted.map((m) => m.id),
    nameKeys: [...nameKeys],
    inns: [...inns].map(([digits, billhubCorrect]) => ({ digits, billhubCorrect })),
  };
}

const plainName = (m: Member): string => m.name.trim() || 'Без названия';

export function buildSupplierFilterGroups(
  rows: readonly SupplierGroupRow[],
  ctx: SupplierGroupContext = {},
): SupplierFilterGroup[] {
  const byKey = new Map<string, Member[]>();
  const groups: SupplierFilterGroup[] = [];
  for (const r of rows) {
    const digits = filterInn(r.inn);
    const correct = isCorrectFilterInn(digits);
    const foreign =
      digits !== null &&
      (ctx.ownInns?.has(digits) === true || ctx.contractorInns?.has(digits) === true);
    const m: Member = { ...r, digits, correct, foreign };
    const key = groupKey(r.name);
    if (!key) {
      // Не с чем сравнивать — отдельная строка с ИНН в подписи.
      groups.push(
        makeGroup(
          '',
          [m],
          (rep) => `${plainName(rep)} (${rep.digits ? `ИНН ${rep.digits}` : 'без ИНН'})`,
        ),
      );
      continue;
    }
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }

  for (const [key, members] of byKey) {
    const billhubInns = new Set(
      members.filter((m) => m.billhubId !== null && m.correct).map((m) => m.digits!),
    );
    if (billhubInns.size <= 1) {
      groups.push(makeGroup(key, members, plainName));
      continue;
    }
    // Тёзки: BillHub даёт разные верные ИНН — у каждого своя строка.
    const rest: Member[] = [];
    const byInn = new Map<string, Member[]>();
    for (const m of members) {
      if (m.digits && billhubInns.has(m.digits)) {
        byInn.set(m.digits, [...(byInn.get(m.digits) ?? []), m]);
      } else {
        rest.push(m);
      }
    }
    for (const [inn, list] of byInn) {
      groups.push(makeGroup(key, list, (rep) => `${plainName(rep)} (ИНН ${inn})`));
    }
    if (rest.length > 0) {
      groups.push(makeGroup(key, rest, (rep) => `${plainName(rep)} (ИНН не подтверждён)`));
    }
  }

  // Подписи обязаны различаться: одинаковые строки в списке — та самая
  // проблема, которую здесь решаем. Совпавшим дописываем начало id.
  const seen = new Map<string, number>();
  for (const g of groups) seen.set(g.label, (seen.get(g.label) ?? 0) + 1);
  for (const g of groups) {
    if ((seen.get(g.label) ?? 0) > 1) g.label = `${g.label} · ${g.value.slice(0, 8)}`;
  }
  return groups.sort(
    (a, b) => a.label.localeCompare(b.label, 'ru') || a.value.localeCompare(b.value),
  );
}

export type SupplierFilterScope = { dirIds: string[]; opIds: string[] };

/** Строки справочника для групп — общий запрос фильтра и списка вариантов. */
export async function loadSupplierGroupRows(app: FastifyInstance): Promise<SupplierGroupRow[]> {
  return app.db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      inn: suppliers.inn,
      aliases: suppliers.aliases,
      billhubId: suppliers.billhubId,
      createdAt: suppliers.createdAt,
    })
    .from(suppliers);
}

/**
 * Группы для показа человеку: с числом документов и «чужими» ИНН, от которых
 * зависит основная запись — та, что окно выбора запишет в документ. Состав
 * групп от этого контекста не зависит, поэтому фильтр (ниже) его не грузит.
 */
export async function loadSupplierFilterGroups(
  app: FastifyInstance,
): Promise<SupplierFilterGroup[]> {
  const [rows, counts, ownInns, cc] = await Promise.all([
    loadSupplierGroupRows(app),
    app.db
      .select({ id: sourceDocuments.supplierDirectoryId, n: drSql<number>`count(*)::int` })
      .from(sourceDocuments)
      .where(isNotNull(sourceDocuments.supplierDirectoryId))
      .groupBy(sourceDocuments.supplierDirectoryId),
    loadOwnInns(app.db),
    app.db.select({ inn: customerCounterparties.inn }).from(customerCounterparties),
  ]);
  const docCount = new Map(counts.map((c) => [c.id, c.n]));
  const contractorInns = new Set(
    cc.map((c) => filterInn(c.inn)).filter((d): d is string => d !== null),
  );
  return buildSupplierFilterGroups(
    rows.map((r) => ({ ...r, docCount: docCount.get(r.id) ?? 0 })),
    { ownInns, contractorInns },
  );
}

export type CounterpartyForMatch = {
  id: string;
  inn: string;
  name: string;
  aliases: readonly string[] | null;
};

/** Почему контрагент попал в выдачу группы: исключение BillHub или имя. */
export type CounterpartyMatch = 'billhub_inn' | 'inn_and_name';

/**
 * Какие операционные контрагенты относятся к выбранным группам (правила — у
 * expandSupplierFilterIds). Отдельно от запроса к базе — тем же кодом считает
 * отчёт scripts/supplier-filter-report.ts.
 */
export function matchCounterpartiesToGroups(
  groups: readonly SupplierFilterGroup[],
  rows: readonly CounterpartyForMatch[],
): Map<string, CounterpartyMatch> {
  // Имена группы — по каждому ИНН её участников, в том числе BillHub: иначе
  // контрагент с тем же именем считался бы найденным «по исключению», и отчёт
  // путал бы искажённое имя с совпавшим. Состав выдачи от этого не зависит.
  const anyName = new Set<string>();
  const namesByInn = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const { digits, billhubCorrect } of g.inns) {
      if (billhubCorrect) anyName.add(digits);
      namesByInn.set(digits, new Set([...(namesByInn.get(digits) ?? []), ...g.nameKeys]));
    }
  }
  const out = new Map<string, CounterpartyMatch>();
  for (const c of rows) {
    const d = filterInn(c.inn);
    if (!d) continue;
    const keys = namesByInn.get(d);
    if (keys && [c.name, ...(c.aliases ?? [])].some((n) => keys.has(groupKey(n)))) {
      out.set(c.id, 'inn_and_name');
    } else if (anyName.has(d)) {
      out.set(c.id, 'billhub_inn');
    }
  }
  return out;
}

/** ИНН, по которым у групп вообще может найтись контрагент. */
function groupInnDigits(groups: readonly SupplierFilterGroup[]): string[] {
  return [...new Set(groups.flatMap((g) => g.inns.map((i) => i.digits)))];
}

/**
 * Что ищет фильтр «Поставщик» по выбранным id справочника.
 *
 *   dirIds — все участники групп выбранных id: документы ссылаются на запись
 *            справочника напрямую (supplier_directory_id);
 *   opIds  — операционные контрагенты по ИНН участников (свой supplier_id
 *            операции и старые документы). ИНН записи BillHub с верной
 *            контрольной суммой берёт контрагента с любым именем — так было и
 *            раньше, на бою так находятся контрагенты с искажённым именем
 *            (20973 «ЗМ ГРУПП» у Вент-Профиля). Это уступка совместимости, а не
 *            подтверждение ИНН: импорт BillHub оставляет прежний ИНН строки.
 *            ИНН остальных участников берёт только контрагента с тем же именем
 *            или алиасом: иначе ТУЛА-СТАЛЬ с ИНН СУ-10 тянула бы приёмки СУ-10.
 *
 * Неизвестный id (запись удалена склейкой) остаётся в dirIds сам по себе и,
 * как и прежде, ничего не находит.
 */
export async function expandSupplierFilterIds(
  app: FastifyInstance,
  ids: readonly string[],
): Promise<SupplierFilterScope> {
  if (ids.length === 0) return { dirIds: [], opIds: [] };
  const groups = buildSupplierFilterGroups(await loadSupplierGroupRows(app));
  const byMember = new Map<string, SupplierFilterGroup>();
  for (const g of groups) for (const id of g.memberIds) byMember.set(id, g);

  const dirIds = new Set<string>();
  const picked = new Set<SupplierFilterGroup>();
  for (const id of ids) {
    const g = byMember.get(id);
    if (g) picked.add(g);
    for (const m of g?.memberIds ?? [id]) dirIds.add(m);
  }

  const digits = groupInnDigits([...picked]);
  if (digits.length === 0) return { dirIds: [...dirIds], opIds: [] };
  const rows = await app.db
    .select({
      id: counterparties.id,
      inn: counterparties.inn,
      name: counterparties.name,
      aliases: counterparties.aliases,
    })
    .from(counterparties)
    .where(
      drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') in ${digits}`,
    );
  return { dirIds: [...dirIds], opIds: [...matchCounterpartiesToGroups([...picked], rows).keys()] };
}
