// Разбор строк выгрузок для импорта справочников. На вход — массив строк
// листа (`XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })`),
// колонки ищутся по заголовкам. Ошибка с fatal=true останавливает импорт до
// любой работы с базой: лучше не записать ничего, чем записать половину.

import { collapseSpaces, extractBracketInn, innDigits } from './names.js';

export type ParseIssue = {
  /** Номер строки листа (1 — заголовок). */
  rowNo: number;
  fatal: boolean;
  code:
    | 'missing_column'
    | 'bad_id'
    | 'duplicate_id'
    | 'empty_name'
    | 'bad_status'
    | 'bad_created_at'
    | 'duplicate_inn'
    | 'bad_bracket_inn';
  message: string;
  value?: string;
};

export type SecurityStatus = 'approved' | 'rejected';

export type BillhubSupplier = {
  rowNo: number;
  /** ID строки в BillHub. */
  id: string;
  name: string;
  innRaw: string;
  aliases: string[];
  securityStatus: SecurityStatus | null;
  comment: string | null;
  createdAt: Date;
};

export type OneCContractor = {
  /** Имя как в 1С, пробелы схлопнуты. */
  raw: string;
  /** Имя без скобки с ИНН. */
  base: string;
  /** ИНН из скобки, если он корректен. */
  inn: string | null;
  rowNos: number[];
  projects: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cell(row: unknown[] | undefined, i: number | undefined): string {
  if (!row || i === undefined) return '';
  const v = row[i];
  return v === null || v === undefined ? '' : String(v);
}

function headerKey(s: string): string {
  return collapseSpaces(s).toLowerCase().replace(/ё/g, 'е');
}

function findHeader(
  rows: unknown[][],
  required: readonly string[],
): { index: number; columns: Map<string, number> } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const columns = new Map<string, number>();
    (rows[r] ?? []).forEach((v, i) => {
      const k = headerKey(String(v ?? ''));
      if (k && !columns.has(k)) columns.set(k, i);
    });
    if (required.every((h) => columns.has(h))) return { index: r, columns };
  }
  return null;
}

const STATUS: Record<string, SecurityStatus | null> = {
  '': null,
  согласован: 'approved',
  отклонен: 'rejected',
};

/** «2026-03-17 18:27» по Москве (UTC+3, без перехода на летнее время). */
export function parseMoscowDateTime(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! - 3, +mi!, s ? +s : 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeComment(raw: string): string | null {
  const s = raw.replace(/\r\n?/g, '\n').trim();
  return s === '' ? null : s;
}

export function parseBillhubSupplierRows(rows: unknown[][]): {
  suppliers: BillhubSupplier[];
  issues: ParseIssue[];
} {
  const issues: ParseIssue[] = [];
  const NAME = 'наименование';
  const INN = 'инн';
  const STATUS_COL = 'статус сб';
  const COMMENT = 'комментарий по учредительным документам';
  const CREATED = 'создан (мск)';
  const ID = 'id';
  const ALIASES = 'альтернативные наименования';
  const required = [NAME, INN, STATUS_COL, COMMENT, CREATED, ID];
  const header = findHeader(rows, [NAME, INN]);
  if (!header) {
    return {
      suppliers: [],
      issues: [
        {
          rowNo: 1,
          fatal: true,
          code: 'missing_column',
          message: 'нет заголовка «Наименование» / «ИНН»',
        },
      ],
    };
  }
  for (const col of required) {
    if (!header.columns.has(col)) {
      issues.push({
        rowNo: header.index + 1,
        fatal: true,
        code: 'missing_column',
        message: `нет колонки «${col}»`,
      });
    }
  }
  if (issues.length > 0) return { suppliers: [], issues };
  const col = (k: string) => header.columns.get(k);

  const suppliers: BillhubSupplier[] = [];
  const seenIds = new Map<string, number>();
  const seenInn = new Map<string, number>();
  for (let r = header.index + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    if (!row || row.every((v) => String(v ?? '').trim() === '')) continue;

    const id = cell(row, col(ID)).trim().toLowerCase();
    const name = cell(row, col(NAME)).trim();
    const innRaw = cell(row, col(INN)).trim();
    const statusRaw = cell(row, col(STATUS_COL)).trim();
    const createdRaw = cell(row, col(CREATED)).trim();

    if (!UUID_RE.test(id)) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'bad_id',
        message: 'ID не похож на UUID',
        value: id,
      });
      continue;
    }
    const firstRow = seenIds.get(id);
    if (firstRow !== undefined) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'duplicate_id',
        message: `ID уже был в строке ${firstRow}`,
        value: id,
      });
      continue;
    }
    seenIds.set(id, rowNo);
    if (!name) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'empty_name',
        message: 'пустое наименование',
        value: id,
      });
      continue;
    }
    const statusKey = statusRaw.toLowerCase().replace(/ё/g, 'е');
    if (!(statusKey in STATUS)) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'bad_status',
        message: 'неизвестный статус СБ',
        value: statusRaw,
      });
      continue;
    }
    const createdAt = parseMoscowDateTime(createdRaw);
    if (!createdAt) {
      issues.push({
        rowNo,
        fatal: true,
        code: 'bad_created_at',
        message: 'дата создания не разобрана',
        value: createdRaw,
      });
      continue;
    }
    const digits = innDigits(innRaw);
    if (digits) {
      const prev = seenInn.get(digits);
      if (prev !== undefined) {
        issues.push({
          rowNo,
          fatal: false,
          code: 'duplicate_inn',
          message: `ИНН уже был в строке ${prev}`,
          value: innRaw,
        });
      } else {
        seenInn.set(digits, rowNo);
      }
    }
    suppliers.push({
      rowNo,
      id,
      name,
      innRaw,
      aliases: cell(row, col(ALIASES)).split(/[;\n]/).map(collapseSpaces).filter(Boolean),
      securityStatus: STATUS[statusKey] ?? null,
      comment: normalizeComment(cell(row, col(COMMENT))),
      createdAt,
    });
  }
  return { suppliers, issues };
}

export function parseOneCContractorRows(rows: unknown[][]): {
  contractors: OneCContractor[];
  issues: ParseIssue[];
} {
  const issues: ParseIssue[] = [];
  const NAME = 'контрагент';
  const PROJECT = 'проектродитель';
  const header = findHeader(rows, [NAME]);
  if (!header) {
    return {
      contractors: [],
      issues: [
        { rowNo: 1, fatal: true, code: 'missing_column', message: 'нет колонки «Контрагент»' },
      ],
    };
  }
  const nameCol = header.columns.get(NAME);
  const projectCol = header.columns.get(PROJECT);

  const byRaw = new Map<string, OneCContractor>();
  for (let r = header.index + 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = r + 1;
    if (!row || row.every((v) => String(v ?? '').trim() === '')) continue;
    const raw = collapseSpaces(cell(row, nameCol));
    if (!raw) {
      issues.push({ rowNo, fatal: false, code: 'empty_name', message: 'пустой контрагент' });
      continue;
    }
    const project = collapseSpaces(cell(row, projectCol));
    const known = byRaw.get(raw);
    if (known) {
      known.rowNos.push(rowNo);
      if (project && !known.projects.includes(project)) known.projects.push(project);
      continue;
    }
    const bracket = extractBracketInn(raw);
    if (bracket.innRaw && !bracket.inn) {
      issues.push({
        rowNo,
        fatal: false,
        code: 'bad_bracket_inn',
        message: 'ИНН в скобках не прошёл контрольную сумму — считаем, что ИНН нет',
        value: raw,
      });
    }
    byRaw.set(raw, {
      raw,
      base: bracket.base,
      inn: bracket.inn,
      rowNos: [rowNo],
      projects: project ? [project] : [],
    });
  }
  return { contractors: [...byRaw.values()], issues };
}
