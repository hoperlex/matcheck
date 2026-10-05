/**
 * Список поставщиков для выгрузки УПД: строки листа Excel → ИНН и названия.
 *
 * Чистая функция: ни файлов, ни базы. Скрипт читает книгу сам и отдаёт сюда
 * строки листа (`sheet_to_json` с `header: 1, raw: false` — тогда ИНН с
 * ведущим нулём приходит строкой, а не числом без нуля).
 *
 * Колонки ищутся по заголовкам, а не по позиции: список собирают руками, и
 * лишняя колонка слева не должна молча превращать названия в ИНН.
 *
 * Отброшенная строка не исчезает молча — у каждой есть номер и причина, чтобы
 * человек мог поправить файл.
 */
import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';

export type SupplierIssueReason = 'empty' | 'length' | 'checksum' | 'duplicate';

export type SupplierIssue = {
  /** Номер строки листа, как его видит человек в Excel (заголовок — строка 1). */
  row: number;
  name: string;
  inn: string;
  reason: SupplierIssueReason;
};

export type SupplierList = {
  /** Нормализованный ИНН → название из списка. Порядок — как в файле. */
  byInn: Map<string, string>;
  issues: SupplierIssue[];
  /** Сколько строк с данными было в листе (без заголовка и полностью пустых). */
  rows: number;
};

export const SUPPLIER_ISSUE_LABELS: Record<SupplierIssueReason, string> = {
  empty: 'ИНН не указан',
  length: 'в ИНН не 10 и не 12 цифр',
  checksum: 'не сходятся контрольные цифры ИНН',
  duplicate: 'ИНН уже встречался выше',
};

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function findColumn(header: string[], names: string[]): number {
  const wanted = names.map((n) => n.toLowerCase());
  return header.findIndex((h) => wanted.includes(h.toLowerCase()));
}

/** Колонки «ИНН» и «Название» по заголовку первой строки. */
export function detectSupplierColumns(header: unknown[]): { inn: number; name: number } | null {
  const texts = header.map(cellText);
  const inn = findColumn(texts, ['ИНН']);
  const name = findColumn(texts, ['Название', 'Наименование', 'Поставщик']);
  if (inn < 0 || name < 0) return null;
  return { inn, name };
}

export function parseSupplierRows(rows: unknown[][]): SupplierList {
  const [header, ...data] = rows;
  const columns = header ? detectSupplierColumns(header) : null;
  if (!columns) {
    throw new Error('в первой строке листа нет колонок «ИНН» и «Название»');
  }

  const byInn = new Map<string, string>();
  const issues: SupplierIssue[] = [];
  let count = 0;

  data.forEach((row, i) => {
    const cells = Array.isArray(row) ? row : [];
    const name = cellText(cells[columns.name]);
    const raw = cellText(cells[columns.inn]);
    // Полностью пустая строка — не поставщик и не ошибка: так выглядит хвост листа.
    if (!name && !raw) return;
    count += 1;
    const rowNo = i + 2;

    if (!raw) {
      issues.push({ row: rowNo, name, inn: raw, reason: 'empty' });
      return;
    }
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 10 && digits.length !== 12) {
      issues.push({ row: rowNo, name, inn: raw, reason: 'length' });
      return;
    }
    const inn = normalizeInn(digits);
    if (!inn) {
      issues.push({ row: rowNo, name, inn: raw, reason: 'checksum' });
      return;
    }
    if (byInn.has(inn)) {
      issues.push({ row: rowNo, name, inn: raw, reason: 'duplicate' });
      return;
    }
    byInn.set(inn, name);
  });

  return { byInn, issues, rows: count };
}
