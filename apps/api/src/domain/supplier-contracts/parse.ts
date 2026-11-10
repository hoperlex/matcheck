// Разбор выгрузки 1С «Договоры с контрагентами» (лист с колонками Кли, КлиИНН,
// Кли_аid_all, Дог, Дог_id_all, Номер, Дата, ВидДоговора, ОбъектВыполнения).
// На вход — строки листа `XLSX.utils.sheet_to_json(ws, { header: 1, defval: '',
// raw: false })`. Фатальная ошибка останавливает импорт до любой работы с базой.

import { cell, findHeader, UUID_RE } from '../directories/parse.js';
import { collapseSpaces, innDigits } from '../directories/names.js';
import type { SupplierContractKind } from '../../db/schema.js';

export type ContractParseIssue = {
  /** Номер строки листа (1 — первая строка листа). */
  rowNo: number;
  fatal: boolean;
  code:
    | 'missing_column'
    | 'bad_id'
    | 'duplicate_id'
    | 'empty_name'
    | 'empty_counterparty'
    | 'bad_inn'
    | 'bad_counterparty_id'
    | 'bad_date'
    | 'unknown_kind';
  message: string;
  value?: string;
};

export type ParsedContract = {
  rowNo: number;
  onecId: string;
  counterpartyOnecId: string | null;
  counterpartyName: string;
  counterpartyInn: string;
  name: string;
  number: string | null;
  /** YYYY-MM-DD или null. */
  contractDate: string | null;
  kind: SupplierContractKind;
  objectText: string | null;
};

/** Заголовки выгрузки после headerKey (нижний регистр, ё→е). «а» в «кли_аid_all» — кириллица, как в 1С. */
export const CONTRACT_HEADERS = {
  counterpartyName: 'кли',
  counterpartyInn: 'клиинн',
  counterpartyId: 'кли_аid_all',
  name: 'дог',
  id: 'дог_id_all',
  number: 'номер',
  date: 'дата',
  kind: 'виддоговора',
  object: 'объектвыполнения',
} as const;

const REQUIRED = [
  CONTRACT_HEADERS.counterpartyName,
  CONTRACT_HEADERS.counterpartyInn,
  CONTRACT_HEADERS.name,
  CONTRACT_HEADERS.id,
  CONTRACT_HEADERS.number,
  CONTRACT_HEADERS.date,
  CONTRACT_HEADERS.kind,
] as const;

const KIND_BY_LABEL: Record<string, SupplierContractKind> = {
  'с поставщиком': 'supplier',
  'с покупателем': 'buyer',
  прочее: 'other',
};

/**
 * Дата дд.мм.гггг → YYYY-MM-DD. Год 2000–2100 и проверка по календарю
 * («31.02.2026» — не дата). null — пусто; undefined — строка есть, но битая.
 */
export function parseContractDate(raw: string): string | null | undefined {
  const s = raw.trim();
  if (s === '') return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (!m) return undefined;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < 2000 || year > 2100) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function parseContractRows(rows: unknown[][]): {
  contracts: ParsedContract[];
  issues: ContractParseIssue[];
} {
  const issues: ContractParseIssue[] = [];
  const header = findHeader(rows, REQUIRED);
  if (!header) {
    const present = new Set(
      (rows[0] ?? []).map((v) => collapseSpaces(String(v ?? '')).toLowerCase().replace(/ё/g, 'е')),
    );
    for (const h of REQUIRED) {
      if (!present.has(h)) {
        issues.push({
          rowNo: 1,
          fatal: true,
          code: 'missing_column',
          message: `Нет колонки «${h}»`,
          value: h,
        });
      }
    }
    if (issues.length === 0) {
      issues.push({ rowNo: 1, fatal: true, code: 'missing_column', message: 'Заголовок не найден' });
    }
    return { contracts: [], issues };
  }

  const col = (h: string) => header.columns.get(h);
  const contracts: ParsedContract[] = [];
  const seen = new Map<string, number>();

  for (let r = header.index + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    const get = (h: string) => collapseSpaces(cell(row, col(h)));
    const id = get(CONTRACT_HEADERS.id).toLowerCase();
    const name = get(CONTRACT_HEADERS.name);
    const counterpartyName = get(CONTRACT_HEADERS.counterpartyName);
    const innRaw = get(CONTRACT_HEADERS.counterpartyInn);
    // Полностью пустая строка в конце листа — не ошибка.
    if (!id && !name && !counterpartyName && !innRaw) continue;

    if (!UUID_RE.test(id)) {
      issues.push({ rowNo, fatal: true, code: 'bad_id', message: 'Дог_id_all не похож на UUID', value: id });
      continue;
    }
    const firstRow = seen.get(id);
    if (firstRow !== undefined) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'duplicate_id',
        message: `Дог_id_all повторяется (впервые в строке ${firstRow})`,
        value: id,
      });
      continue;
    }
    seen.set(id, rowNo);

    if (!name) {
      issues.push({ rowNo, fatal: true, code: 'empty_name', message: 'Пустое наименование договора' });
      continue;
    }
    if (!counterpartyName) {
      issues.push({ rowNo, fatal: true, code: 'empty_counterparty', message: 'Пустое наименование контрагента' });
      continue;
    }
    const inn = innDigits(innRaw);
    if (!inn || innRaw.replace(/[\d\s]/g, '') !== '') {
      issues.push({ rowNo, fatal: true, code: 'bad_inn', message: 'ИНН не 10/12 цифр', value: innRaw });
      continue;
    }

    let counterpartyOnecId: string | null = get(CONTRACT_HEADERS.counterpartyId).toLowerCase() || null;
    if (counterpartyOnecId && !UUID_RE.test(counterpartyOnecId)) {
      issues.push({
        rowNo,
        fatal: false,
        code: 'bad_counterparty_id',
        message: 'Кли_аid_all не похож на UUID — не сохраняем',
        value: counterpartyOnecId,
      });
      counterpartyOnecId = null;
    }

    const dateRaw = get(CONTRACT_HEADERS.date);
    let contractDate = parseContractDate(dateRaw);
    if (contractDate === undefined) {
      issues.push({ rowNo, fatal: false, code: 'bad_date', message: 'Дата не распознана — пусто', value: dateRaw });
      contractDate = null;
    }

    const kindRaw = get(CONTRACT_HEADERS.kind);
    let kind = KIND_BY_LABEL[kindRaw.toLowerCase().replace(/ё/g, 'е')];
    if (!kind) {
      issues.push({
        rowNo,
        fatal: false,
        code: 'unknown_kind',
        message: 'Вид договора не распознан — «прочее»',
        value: kindRaw,
      });
      kind = 'other';
    }

    contracts.push({
      rowNo,
      onecId: id,
      counterpartyOnecId,
      counterpartyName,
      counterpartyInn: inn,
      name,
      number: get(CONTRACT_HEADERS.number) || null,
      contractDate,
      kind,
      objectText: get(CONTRACT_HEADERS.object) || null,
    });
  }
  return { contracts, issues };
}
