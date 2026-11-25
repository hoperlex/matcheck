// Разбор выгрузки 1С «Списание по субподряду» для связи подрядчик × объект.
//
// Лист TDSheet: ПроектРодитель (объект строкой), Контрагент (имя подрядчика,
// иногда с ИНН в скобках), число и сумма документов «Реализация» и
// «Давальческий акт». Список подрядчиков берём тем же разбором, что и импорт
// справочников 21.10 (parseOneCContractorRows): имена совпадают байт в байт с
// ключами planContractors.
//
// Пустые числа в выгрузке — ячейки-ошибки (t='e'): SheetJS отдаёт их пустой
// строкой, считаем нулём. Пустой или ошибочный ПроектРодитель — «объект не
// определён», решает план.

import XLSX from 'xlsx';
import {
  cell,
  findHeader,
  parseOneCContractorRows,
  type OneCContractor,
  type ParseIssue,
} from '../directories/parse.js';
import { collapseSpaces } from '../directories/names.js';

/** Заголовки после headerKey (нижний регистр, ё→е, пробелы схлопнуты). */
export const CONTRACTOR_SITE_HEADERS = {
  name: 'контрагент',
  project: 'проектродитель',
  realizationDocs: 'количестводокументовреализация',
  realizationSum: 'суммадокументовреализаций',
  tollingDocs: 'количестводокументовдавальческийакт',
  tollingSum: 'суммадокументовдавальческийакт',
} as const;

const REQUIRED = Object.values(CONTRACTOR_SITE_HEADERS);

export type ContractorSiteIssue = {
  /** Номер строки листа (1 — заголовок). */
  rowNo: number;
  fatal: boolean;
  code: ParseIssue['code'] | 'bad_number' | 'zero_row' | 'count_sum_mismatch';
  message: string;
  value?: string;
};

export type ContractorSiteRow = {
  rowNo: number;
  /** Имя подрядчика, как его отдаёт parseOneCContractorRows (пробелы схлопнуты). */
  raw: string;
  /** ПроектРодитель; '' — пусто или ячейка-ошибка. */
  objectText: string;
  realizationDocs: number;
  /** Сумма в копейках — без накопления ошибок double при склейке строк. */
  realizationKop: number;
  tollingDocs: number;
  tollingKop: number;
};

export type ContractorSitesSheet = {
  /** Как видит пользователь (raw: false) — для имён и объектов. */
  text: unknown[][];
  /** Сырые значения (raw: true) — для чисел. */
  values: unknown[][];
};

/** Лист книги 1С. Только SheetJS: ExcelJS не видит xl/SharedStrings.xml с заглавной. */
export function readContractorSitesSheet(
  wb: XLSX.WorkBook,
  preferred = 'TDSheet',
): ContractorSitesSheet | null {
  const name = wb.SheetNames.includes(preferred) ? preferred : wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws) return null;
  return {
    text: XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false }),
    values: XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true }),
  };
}

type NumberResult = { ok: true; value: number } | { ok: false; raw: string };

/** Пусто или ячейка-ошибка → 0; число ≥ 0 (целое для количества) → число; иначе ошибка. */
function readNumber(v: unknown, integer: boolean): NumberResult {
  if (v === null || v === undefined) return { ok: true, value: 0 };
  if (typeof v === 'string') {
    if (v.trim() === '') return { ok: true, value: 0 };
    return { ok: false, raw: v };
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, raw: String(v) };
  if (integer && !Number.isInteger(v)) return { ok: false, raw: String(v) };
  return { ok: true, value: integer ? v : Math.round(v * 100) };
}

export function parseContractorSiteRows(sheet: ContractorSitesSheet): {
  rows: ContractorSiteRow[];
  contractors: OneCContractor[];
  issues: ContractorSiteIssue[];
} {
  const { text, values } = sheet;
  const header = findHeader(text, REQUIRED);
  if (!header) {
    return {
      rows: [],
      contractors: [],
      issues: [
        {
          rowNo: 1,
          fatal: true,
          code: 'missing_column',
          message: `нет колонок: ${REQUIRED.join(', ')} (нужны все)`,
        },
      ],
    };
  }
  const parsed = parseOneCContractorRows(text);
  const issues: ContractorSiteIssue[] = [...parsed.issues];
  const col = (h: string) => header.columns.get(h);
  const rows: ContractorSiteRow[] = [];

  for (let r = header.index + 1; r < text.length; r++) {
    const row = text[r];
    const rowNo = r + 1;
    if (!row || row.every((v) => String(v ?? '').trim() === '')) continue;
    const raw = collapseSpaces(cell(row, col(CONTRACTOR_SITE_HEADERS.name)));
    // Пустое имя уже отмечено разбором подрядчиков.
    if (!raw) continue;

    const nums: Record<'rd' | 'rs' | 'td' | 'ts', number> = { rd: 0, rs: 0, td: 0, ts: 0 };
    let bad = false;
    for (const [key, h, integer] of [
      ['rd', CONTRACTOR_SITE_HEADERS.realizationDocs, true],
      ['rs', CONTRACTOR_SITE_HEADERS.realizationSum, false],
      ['td', CONTRACTOR_SITE_HEADERS.tollingDocs, true],
      ['ts', CONTRACTOR_SITE_HEADERS.tollingSum, false],
    ] as const) {
      const res = readNumber(values[r]?.[col(h)!], integer);
      if (res.ok) nums[key] = res.value;
      else {
        bad = true;
        issues.push({
          rowNo,
          fatal: true,
          code: 'bad_number',
          message: `«${h}»: ожидается ${integer ? 'целое' : 'число'} ≥ 0`,
          value: res.raw,
        });
      }
    }
    if (bad) continue;

    if (nums.rd === 0 && nums.td === 0) {
      issues.push({
        rowNo,
        fatal: false,
        code: 'zero_row',
        message: 'нет ни реализаций, ни давальческих актов — строка пропущена',
        value: raw,
      });
      continue;
    }
    if (nums.rd > 0 !== nums.rs > 0 || nums.td > 0 !== nums.ts > 0) {
      issues.push({
        rowNo,
        fatal: false,
        code: 'count_sum_mismatch',
        message: 'есть документы без суммы или сумма без документов — вид считаем по количеству',
        value: raw,
      });
    }
    rows.push({
      rowNo,
      raw,
      objectText: collapseSpaces(cell(row, col(CONTRACTOR_SITE_HEADERS.project))),
      realizationDocs: nums.rd,
      realizationKop: nums.rs,
      tollingDocs: nums.td,
      tollingKop: nums.ts,
    });
  }
  return { rows, contractors: parsed.contractors, issues };
}
