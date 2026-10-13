/**
 * Сверка документа из списка Диадока со строкой реестра выгрузки.
 *
 * Реестр заполняется из XML, список — из карточки Диадока (`Metadata`). Если
 * они расходятся, это и есть то «реестр не совпадает с Диадоком», которое
 * видит человек, поэтому сравнение строгое:
 * - деньги — в копейках и точно: допуск спрятал бы ровно ту копейку, ради
 *   которой сверяем;
 * - нет значения с одной из сторон — «нет данных», а не «совпало» и не
 *   «расходится».
 */
import { metadataMap } from './document-meta.js';
import { toIsoDate } from './export-upd.js';
import type { DiadocListedDocument } from './diadoc.types.js';

export type FieldName = 'number' | 'date' | 'function' | 'total' | 'vat' | 'sellerInn';
export type FieldVerdict = 'equal' | 'diff' | 'no_data';

export type FieldCheck = {
  field: FieldName;
  diadoc: string | null;
  registry: string | null;
  verdict: FieldVerdict;
};

/** Строка реестра в том виде, в каком её сравниваем. Дата — `YYYY-MM-DD`. */
export type RegistrySide = {
  documentNumber: string | null;
  documentDate: string | null;
  documentFunction: string | null;
  totalSum: string | null;
  vatSum: string | null;
  sellerInns: readonly string[];
};

/**
 * Сумма в копейках. Принимает «1234.5», «1 234,50», «-12»; всё прочее — null:
 * нераспознанная сумма не должна молча стать нулём.
 */
export function moneyToKopecks(raw: string | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\s/g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const kopecks = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -kopecks : kopecks;
}

export function formatKopecks(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Номер для сравнения: без регистра и пробелов по краям. */
export function normalizeDocNumber(raw: string | null | undefined): string | null {
  const value = raw?.trim().toUpperCase();
  return value ? value : null;
}

function check(field: FieldName, diadoc: string | null, registry: string | null, equal: boolean): FieldCheck {
  if (diadoc === null || registry === null) return { field, diadoc, registry, verdict: 'no_data' };
  return { field, diadoc, registry, verdict: equal ? 'equal' : 'diff' };
}

function moneyCheck(field: 'total' | 'vat', diadocRaw: string | undefined, registryRaw: string | null): FieldCheck {
  const d = moneyToKopecks(diadocRaw);
  const r = moneyToKopecks(registryRaw);
  return check(
    field,
    d === null ? (diadocRaw?.trim() || null) : formatKopecks(d),
    r === null ? registryRaw : formatKopecks(r),
    d !== null && r !== null && d === r,
  );
}

/** Сверка реквизитов по полям. Порядок полей постоянный — по нему строятся сводки. */
export function compareWithRegistry(doc: DiadocListedDocument, row: RegistrySide): FieldCheck[] {
  const meta = metadataMap(doc.Metadata);

  const dNumber = normalizeDocNumber(meta.DocumentNumber ?? doc.DocumentNumber);
  const rNumber = normalizeDocNumber(row.documentNumber);

  const dDate = toIsoDate(meta.DocumentDate ?? doc.DocumentDate);
  const rDate = row.documentDate;

  const dFunction = doc.Function?.trim().toUpperCase() || null;
  const rFunction = row.documentFunction?.trim().toUpperCase() || null;

  const dInn = meta.SellerInn?.replace(/\D/g, '') || null;
  const rInns = row.sellerInns.filter(Boolean);

  return [
    check('number', dNumber, rNumber, dNumber === rNumber),
    check('date', dDate, rDate, dDate === rDate),
    check('function', dFunction, rFunction, dFunction === rFunction),
    moneyCheck('total', meta.TotalSum, row.totalSum),
    moneyCheck('vat', meta.TotalVat, row.vatSum),
    check('sellerInn', dInn, rInns.length ? rInns.join(',') : null, dInn !== null && rInns.includes(dInn)),
  ];
}

/** Состояние документа в Диадоке — для сводок и будущих колонок реестра. */
export type ListedDocumentState = {
  direction: string | null;
  recipientResponse: string | null;
  revocation: string | null;
  docflowText: string | null;
  isDeleted: boolean;
  isTest: boolean;
};

function enumText(value: string | number | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : String(value);
}

export function listedDocumentState(doc: DiadocListedDocument): ListedDocumentState {
  const docflow = doc.DocflowStatus as { PrimaryStatus?: { StatusText?: unknown } } | undefined;
  const text = docflow?.PrimaryStatus?.StatusText;
  return {
    direction: doc.DocumentDirection ?? null,
    recipientResponse: enumText(doc.RecipientResponseStatus),
    revocation: enumText(doc.RevocationStatus),
    docflowText: typeof text === 'string' && text.trim() ? text.trim() : null,
    isDeleted: doc.IsDeleted === true,
    isTest: doc.IsTest === true,
  };
}

export function isInbound(doc: Pick<DiadocListedDocument, 'DocumentDirection'>): boolean {
  return /inbound/i.test(doc.DocumentDirection ?? '');
}
