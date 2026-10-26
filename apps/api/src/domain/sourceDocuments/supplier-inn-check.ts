// Проверка ИНН поставщика из ответа модели (флаг SUPPLIER_INN_CHECK).
//
// Модель путает цифры ИНН: заменяет, переставляет, теряет; ставит девять цифр
// КПП; читает ИНН самой СУ-10 из чужой графы. Раньше такой ИНН уходил в
// matchOrCreateSupplier как есть: точный поиск промахивался, нечёткий пропускал
// правильную запись («ИНН другой»), и в справочнике заводился дубль с битым
// ИНН. Блокировка (PARTY_RESOLUTION_V1=on) не годится: документ остаётся без
// поставщика — пропадает имя, не склеиваются сегменты, не ловятся дубли.
//
// Здесь ИНН исправляется по тому, чему можно верить:
//   - реестр ЭДО — та же УПД (длинный номер, дата, сумма) с ИНН из XML;
//   - справочник — запись с тем же именем и корректным ИНН в одной цифре от
//     прочитанного или, если такая запись одна на имя, в двух.
// Неисправимый ИНН в справочник не попадает: поставщик выбирается по имени, а
// документ получает предупреждение supplier_inn_unverified.
//
// Решатель — чистая функция; ветки перечислены в тестах
// (test/supplier-inn-check.test.ts) на реальных парах с боя.

import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { UpdValidation, UpdWarning } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { loadEnv } from '../../lib/env.js';
import { edoAccounts, edoExportDocuments, suppliers } from '../../db/schema.js';
import { companyKey, editDistance, formsCompatible } from '../directories/names.js';
import { normalizeDocumentNumber } from '../operations/edo-match.js';
import { normalizeInn } from './resolve-contractor.js';
import {
  matchOrCreateSupplier,
  type ParsedSupplier,
  type SupplierMatch,
} from './supplierMatcher.js';

export type SupplierInnCheckMode = 'off' | 'shadow' | 'on';

export type SupplierInnDecision = 'valid' | 'normalized' | 'corrected' | 'unverified' | 'absent';

export type SupplierInnCheck = {
  decision: SupplierInnDecision;
  /** ИНН, как его прочитала модель. */
  raw: string | null;
  /** Итоговый ИНН; null у unverified и absent. */
  inn: string | null;
  source?: 'edo' | 'directory' | 'directory_name';
  /** unverified: ИНН записи справочника, к которой документ привязан по имени. */
  linkInn?: string;
  /** Почему ИНН не принят как есть. */
  reason?: 'checksum' | 'length' | 'own_inn';
  /** Корректные ИНН справочника с тем же именем — когда выбрать один нельзя. */
  candidates?: string[];
};

/** След в source_documents.supplier_inn_check (миграция 0138). */
export type SupplierInnCheckTrace = SupplierInnCheck & { mode: 'shadow' | 'on' };

/** Корректный ИНН справочника со всеми именами записей (название и алиасы). */
export type DirectoryInn = { inn: string; names: string[] };

export type EdoRegistryEntry = {
  number: string | null;
  supplierInn: string | null;
  sellerInns: string[];
  supplierName: string | null;
  totalSum: number | null;
};

export type SupplierInnInput = {
  raw: string | null;
  name: string | null;
  docNumber: string | null;
  totalSum: number | null;
  directory: readonly DirectoryInn[];
  edo: readonly EdoRegistryEntry[];
  ownInns: ReadonlySet<string>;
};

/** Короче — случайные совпадения номера: «1», «12», «105» есть у многих продавцов. */
const EDO_MIN_NUMBER_LENGTH = 5;
const SUM_TOLERANCE = 0.01;

/**
 * ИНН из реестра ЭДО для этой УПД: тот же номер (не короче 5 знаков), та же
 * дата (отобрано при загрузке), та же сумма, ровно один продавец и это не
 * своя организация. Битый ИНН подменяем, если ЭДО-ИНН рядом (≤ 2 цифры) или
 * совпало имя; корректный — только если рядом: далёкий корректный ИНН говорит
 * скорее о другом документе с тем же номером.
 */
function edoInn(input: SupplierInnInput, digits: string, allowNameMatch: boolean): string | null {
  const number = normalizeDocumentNumber(input.docNumber);
  if (number.length < EDO_MIN_NUMBER_LENGTH || input.totalSum === null) return null;
  const found = new Map<string, Set<string>>();
  for (const e of input.edo) {
    if (normalizeDocumentNumber(e.number) !== number) continue;
    if (e.totalSum === null || Math.abs(e.totalSum - input.totalSum) > SUM_TOLERANCE) continue;
    for (const raw of [e.supplierInn, ...e.sellerInns]) {
      const inn = normalizeInn(raw);
      if (!inn || input.ownInns.has(inn)) continue;
      const names = found.get(inn) ?? new Set<string>();
      if (e.supplierName) names.add(e.supplierName);
      found.set(inn, names);
    }
  }
  if (found.size !== 1) return null;
  const [inn, names] = [...found][0]!;
  if (digits && editDistance(digits, inn) <= 2) return inn;
  if (allowNameMatch && input.name) {
    const key = companyKey(input.name);
    if (key && [...names].some((n) => companyKey(n) === key)) return inn;
  }
  return null;
}

/** Корректные ИНН справочника с тем же ключом имени и совместимой формой. */
function sameNameInns(input: SupplierInnInput): string[] {
  if (!input.name) return [];
  const key = companyKey(input.name);
  if (!key) return [];
  const out = new Set<string>();
  for (const d of input.directory) {
    if (input.ownInns.has(d.inn)) continue;
    if (d.names.some((n) => companyKey(n) === key && formsCompatible(input.name!, n)))
      out.add(d.inn);
  }
  return [...out].sort();
}

export function resolveSupplierInn(input: SupplierInnInput): SupplierInnCheck {
  const raw = input.raw?.trim() || null;
  const digits = (raw ?? '').replace(/\D/g, '');
  // Без цифр это не ИНН — ведём себя как при пустом.
  if (!raw || !digits) return { decision: 'absent', raw, inn: null };

  const valid = normalizeInn(raw);
  if (valid && input.ownInns.has(valid)) {
    return { decision: 'unverified', raw, inn: null, reason: 'own_inn' };
  }
  if (valid) {
    const fromEdo = edoInn(input, valid, false);
    if (fromEdo && fromEdo !== valid)
      return { decision: 'corrected', raw, inn: fromEdo, source: 'edo' };
    return { decision: raw === valid ? 'valid' : 'normalized', raw, inn: valid };
  }

  const reason = digits.length === 10 || digits.length === 12 ? 'checksum' : 'length';
  const fromEdo = edoInn(input, digits, true);
  if (fromEdo) return { decision: 'corrected', raw, inn: fromEdo, source: 'edo', reason };

  const inns = sameNameInns(input);
  const near = inns.filter((inn) => editDistance(digits, inn) <= 1);
  if (near.length === 1)
    return { decision: 'corrected', raw, inn: near[0]!, source: 'directory', reason };
  if (inns.length === 1) {
    const only = inns[0]!;
    if (editDistance(digits, only) === 2) {
      return { decision: 'corrected', raw, inn: only, source: 'directory_name', reason };
    }
    // Битый ИНН не принадлежит никакой организации, так что единственная
    // одноимённая — лучшая догадка; но человек должен её подтвердить.
    return { decision: 'unverified', raw, inn: null, reason, linkInn: only };
  }
  return {
    decision: 'unverified',
    raw,
    inn: null,
    reason,
    ...(inns.length > 1 ? { candidates: inns } : {}),
  };
}

// ─── Контекст из базы ──────────────────────────────────────────────────────

const OWN_INNS_TTL_MS = 10 * 60 * 1000;
let ownInnsCache: { at: number; inns: Set<string> } | null = null;

export async function loadOwnInns(db: Db): Promise<Set<string>> {
  if (ownInnsCache && Date.now() - ownInnsCache.at < OWN_INNS_TTL_MS) return ownInnsCache.inns;
  const rows = await db
    .select({ inn: edoAccounts.orgInn })
    .from(edoAccounts)
    .where(isNotNull(edoAccounts.orgInn));
  const inns = new Set(rows.map((r) => normalizeInn(r.inn)).filter((v): v is string => v !== null));
  ownInnsCache = { at: Date.now(), inns };
  return inns;
}

/** Сбросить кэш своих ИНН (для тестов). */
export function resetSupplierInnCheckCache(): void {
  ownInnsCache = null;
}

export async function loadDirectoryInns(db: Db): Promise<DirectoryInn[]> {
  const rows = await db
    .select({ inn: suppliers.inn, name: suppliers.name, aliases: suppliers.aliases })
    .from(suppliers);
  const byInn = new Map<string, string[]>();
  for (const r of rows) {
    const inn = normalizeInn(r.inn);
    if (!inn) continue;
    byInn.set(inn, [...(byInn.get(inn) ?? []), r.name, ...(r.aliases ?? [])]);
  }
  return [...byInn].map(([inn, names]) => ({ inn, names }));
}

async function loadEdoForDate(db: Db, docDate: string): Promise<EdoRegistryEntry[]> {
  // Строки СБИС — только при включённом EDO_SBIS_ENABLED: первая загрузка
  // истории идёт вручную до включения, и до него распознавание их не видит.
  // Копии одной УПД у двух операторов несут один ИНН — «ровно один продавец»
  // ниже от них не ломается.
  const sbisEnabled = loadEnv().EDO_SBIS_ENABLED;
  const rows = await db
    .select({
      number: edoExportDocuments.documentNumber,
      supplierInn: edoExportDocuments.supplierInn,
      sellerInns: edoExportDocuments.sellerInns,
      supplierName: edoExportDocuments.supplierName,
      totalSum: edoExportDocuments.totalSum,
    })
    .from(edoExportDocuments)
    .innerJoin(edoAccounts, eq(edoAccounts.id, edoExportDocuments.edoAccountId))
    .where(
      and(
        eq(sql`${edoExportDocuments.documentDate}::date`, sql`${docDate}::date`),
        sbisEnabled ? undefined : ne(edoAccounts.provider, 'sbis'),
      ),
    );
  return rows.map((r) => ({
    number: r.number,
    supplierInn: r.supplierInn,
    sellerInns: r.sellerInns ?? [],
    supplierName: r.supplierName,
    totalSum: r.totalSum === null ? null : Number(r.totalSum),
  }));
}

/** Дата документа «ГГГГ-ММ-ДД» из ответа модели; иначе null. */
function isoDay(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : null;
}

/**
 * Проверить ИНН поставщика документа. Справочник читается только для битого
 * ИНН, реестр ЭДО — только когда номер и сумма позволяют им воспользоваться.
 */
export async function checkSupplierInn(
  db: Db,
  supplier: ParsedSupplier,
  doc: { docNumber: string | null; docDate: string | Date | null; totalSum: number | null },
): Promise<SupplierInnCheck> {
  const raw = supplier.inn?.trim() || null;
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!raw || !digits) return { decision: 'absent', raw, inn: null };

  const ownInns = await loadOwnInns(db);
  const day = isoDay(doc.docDate);
  const edoUsable =
    day !== null &&
    doc.totalSum !== null &&
    normalizeDocumentNumber(doc.docNumber).length >= EDO_MIN_NUMBER_LENGTH;
  const needDirectory = normalizeInn(raw) === null;
  const [edo, directory] = await Promise.all([
    edoUsable ? loadEdoForDate(db, day) : Promise.resolve([]),
    needDirectory ? loadDirectoryInns(db) : Promise.resolve([]),
  ]);
  return resolveSupplierInn({
    raw,
    name: supplier.name?.trim() || null,
    docNumber: doc.docNumber,
    totalSum: doc.totalSum,
    directory,
    edo,
    ownInns,
  });
}

/**
 * Привязка к справочнику по решению (режим on). Битый ИНН в справочник не
 * попадает ни поиском, ни созданием записи.
 */
export async function matchSupplierByInnCheck(
  app: { db: Db },
  supplier: ParsedSupplier,
  check: SupplierInnCheck,
): Promise<SupplierMatch | null> {
  const name = supplier.name?.trim() || null;
  switch (check.decision) {
    case 'absent':
      return name ? matchOrCreateSupplier(app, { ...supplier, inn: null }) : null;
    case 'valid':
    case 'normalized':
    case 'corrected':
      return matchOrCreateSupplier(app, { ...supplier, inn: check.inn });
    case 'unverified':
      if (check.linkInn) return matchOrCreateSupplier(app, { ...supplier, inn: check.linkInn });
      // Только записи без ИНН: иначе нечёткий поиск по имени выбрал бы одну из
      // одноимённых организаций наугад.
      return name
        ? matchOrCreateSupplier(app, { ...supplier, inn: null }, { candidates: 'empty_inn' })
        : null;
  }
}

/**
 * Что писать в source_documents.supplier_inn_raw: исправленный ИНН, чтобы
 * список, карточка и приёмки (они показывают его раньше справочного) показали
 * верный. Исходное значение остаётся в следе.
 */
export function supplierInnForDocument(check: SupplierInnCheck, raw: string | null): string | null {
  return check.decision === 'corrected' || check.decision === 'normalized' ? check.inn : raw;
}

export const SUPPLIER_INN_WARNING = 'supplier_inn_unverified' as const;

/**
 * Снять прежнее предупреждение о ИНН поставщика и, если нужно, поставить
 * актуальное. Предупреждение устойчивое (PERSISTENT_UPD_WARNING_NAMES), поэтому
 * без снятия оно пережило бы повторный разбор с уже верным ИНН.
 */
export function withSupplierInnWarning(
  validation: UpdValidation,
  check: SupplierInnCheck | null,
): UpdValidation {
  const kept = (validation.warnings ?? []).filter((w) => w.name !== SUPPLIER_INN_WARNING);
  const stale = kept.length !== (validation.warnings ?? []).length;
  if (check?.decision !== 'unverified')
    return stale ? { ...validation, warnings: kept } : validation;
  // Сырой ИНН и причина — в следе supplier_inn_check, карточка берёт их оттуда.
  const warning: UpdWarning = { name: SUPPLIER_INN_WARNING, scope: 'document' };
  return { ...validation, warnings: [...kept, warning] };
}

/** То же для документа без сверки (накладная): validation может быть пуст. */
export function supplierInnValidation(
  validation: UpdValidation | null,
  check: SupplierInnCheck | null,
): UpdValidation | null {
  if (validation) return withSupplierInnWarning(validation, check);
  if (check?.decision !== 'unverified') return null;
  return withSupplierInnWarning(
    { hasMismatch: false, checkedAt: new Date().toISOString(), checks: [] },
    check,
  );
}
