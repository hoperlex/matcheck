import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import {
  UpdPdfParsedSchema,
  type UpdPdfParsed,
  type UpdPdfItem,
} from '@matcheck/contracts';

// Локальный парсер УПД из xlsx (без LLM). Поддерживает обе формы:
//   А — 1С/Элевел 2026 (новая редакция постановления 1137, графы 1–14 с
//       подграфами; поля шапки в одной ячейке: «Продавец: <name>»).
//   Б — 1С 2021 (старая форма, графы 1–11; поля шапки разнесены по соседним
//       ячейкам той же строки: «Продавец:» + «<name>»).
//
// Стратегия:
//  • Собираем все непустые ячейки первого листа в строки (rows[]) с map
//    col→value, и параллельно текстовую «склейку строки» — она нужна
//    регуляркам шапки (универсальной для обеих форм).
//  • Шапку (номер/дату/стороны) ищем по текстовым строкам.
//  • Табличную часть и итоги ищем через «marker-строку» с номерами граф
//    («А», «1», «1а», «2», «2а», «3», «4», «5», «7», «8», «9»). Эта строка
//    одинакова в обеих формах УПД (она и есть стандарт 1137), но excel-
//    координаты колонок плавают, поэтому маппинг «графа УПД → excel col»
//    строится по найденной строке. Дальше каждую позицию вытягиваем по
//    этим колонкам — без хрупкой привязки к конкретным буквам.
//
// Используем ExcelJS streaming WorkbookReader — он НЕ вызывает reconcile,
// который в нестриминговом xlsx.load() падает с TypeError на 1С-выгрузках
// (баг ExcelJS 4.4). Стриминг устойчив к таким файлам и быстрее.

type RawRow = {
  rowNumber: number;
  cells: Map<number, ExcelJS.CellValue>;
  text: string;
};

export async function parseUpdXlsx(buffer: Buffer): Promise<UpdPdfParsed> {
  const rows = await collectRows(buffer);
  const lines = rows.map((r) => r.text).filter(Boolean);

  const { docNumber, docDate } = parseDocHeader(lines);
  const { supplier, recipient } = parseParties(lines);
  const { items, totalSum, vatSum, itemsCount } = parseItemsAndTotals(rows);

  const filledHeader = [
    docNumber !== null,
    docDate !== null,
    supplier?.inn !== undefined && supplier?.inn !== null,
    supplier?.name !== undefined && supplier?.name !== null,
    recipient?.inn !== undefined && recipient?.inn !== null,
    recipient?.name !== undefined && recipient?.name !== null,
  ].filter(Boolean).length;
  // Если есть позиции и итог — высокая уверенность; иначе только шапка
  // (макс 0.85). 6/6 + items+total → 0.95.
  const confidenceHeader = filledHeader === 0 ? 0 : Math.min(0.85, 0.25 + filledHeader * 0.1);
  const confidence =
    items.length > 0 && totalSum !== null ? Math.max(confidenceHeader, 0.95) : confidenceHeader;

  const parsed: UpdPdfParsed = {
    docNumber,
    docDate,
    totalSum,
    vatSum,
    itemsCount,
    supplier,
    recipient,
    items,
    confidence,
  };
  return UpdPdfParsedSchema.parse(parsed);
}

// ─── Сбор строк ────────────────────────────────────────────────────────────

async function collectRows(buffer: Buffer): Promise<RawRow[]> {
  const stream = Readable.from(buffer);
  // sharedStrings: 'cache' нужен для УПД из 1С — там >100 общих строк, без
  // кэша при стриминге cell.value придёт как индекс, а не текст.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
  });

  const rows: RawRow[] = [];
  let firstSheetDone = false;
  for await (const ws of reader) {
    if (firstSheetDone) break;
    for await (const row of ws) {
      const cells = new Map<number, ExcelJS.CellValue>();
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const col = typeof cell.col === 'number' ? cell.col : Number(cell.col);
        if (Number.isFinite(col)) cells.set(col, cell.value);
        const s = cellToString(cell.value);
        if (s) parts.push(s);
      });
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (cells.size === 0) continue;
      rows.push({ rowNumber: row.number, cells, text });
    }
    firstSheetDone = true;
  }
  return rows;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
      return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    if ('result' in v && (v as ExcelJS.CellFormulaValue).result !== undefined) {
      const r = (v as ExcelJS.CellFormulaValue).result;
      if (r === null || r === undefined) return '';
      if (typeof r === 'string') return r;
      if (typeof r === 'number') return String(r);
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      return '';
    }
    if ('text' in v) {
      const t = (v as ExcelJS.CellHyperlinkValue).text;
      return typeof t === 'string' ? t : '';
    }
    if ('error' in v) return '';
  }
  return '';
}

function normCell(v: ExcelJS.CellValue): string {
  return cellToString(v).replace(/[\s \n\t]+/g, ' ').trim();
}

function parseNum(v: ExcelJS.CellValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v !== null && 'result' in v) {
    return parseNum((v as ExcelJS.CellFormulaValue).result ?? null);
  }
  const s = cellToString(v);
  if (!s) return null;
  // «1 234,56» / «1234.56» / «1 234 567,89». Убираем пробелы и nbsp,
  // запятую → точку, отбрасываем всё лишнее (валютные символы, «руб.»).
  const cleaned = s
    .replace(/[\s ]/g, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseVatRate(v: ExcelJS.CellValue): number | null {
  const s = cellToString(v).trim();
  if (!s) return null;
  // «22%», «20 %», «10%», «0%»
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(s);
  if (m && m[1]) return Number(m[1].replace(',', '.'));
  if (/без\s*ндс|без\s*налога/i.test(s)) return 0;
  // Цифра без % (некоторые 1С-формы)
  const justNum = parseNum(v);
  if (justNum !== null && justNum >= 0 && justNum <= 30) return justNum;
  return null;
}

// ─── Шапка ─────────────────────────────────────────────────────────────────

const RU_MONTHS: ReadonlyArray<[RegExp, string]> = [
  [/^январ/i, '01'],
  [/^феврал/i, '02'],
  [/^март/i, '03'],
  [/^апрел/i, '04'],
  [/^мая$|^май/i, '05'],
  [/^июн/i, '06'],
  [/^июл/i, '07'],
  [/^август/i, '08'],
  [/^сентябр/i, '09'],
  [/^октябр/i, '10'],
  [/^ноябр/i, '11'],
  [/^декабр/i, '12'],
];

function parseRuDate(s: string): string | null {
  // «29 мая 2026 г.» / «10 апреля 2023 г.»
  const mWord = /(\d{1,2})\s+([А-Яа-яЁё]+)\s+(\d{4})/.exec(s);
  if (mWord && mWord[1] && mWord[2] && mWord[3]) {
    const day = mWord[1].padStart(2, '0');
    const month = RU_MONTHS.find(([re]) => re.test(mWord[2]!))?.[1] ?? null;
    if (month) return `${mWord[3]}-${month}-${day}`;
  }
  // «29.05.2026» / «29.05.26»
  const mDot = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s);
  if (mDot && mDot[1] && mDot[2] && mDot[3]) {
    const day = mDot[1].padStart(2, '0');
    const month = mDot[2].padStart(2, '0');
    const year = mDot[3].length === 2 ? `20${mDot[3]}` : mDot[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}

function parseDocHeader(lines: string[]): {
  docNumber: string | null;
  docDate: string | null;
} {
  // Первая стратегия — основная строка «Счет-фактура № N от <дата>».
  // Маркер «(1)» в конце строки опционален.
  const reHeader =
    /Сч[её]т-фактура\s+№\s*(\S+?)\s+от\s+(.+?)(?:\s*\(1\)|$)/i;
  for (const line of lines) {
    const m = reHeader.exec(line);
    if (m && m[1] && m[2]) {
      const docDate = parseRuDate(m[2]);
      if (docDate) return { docNumber: m[1], docDate };
    }
  }
  // Fallback — строка «Документ об отгрузке … УПД № N от dd.mm.yyyy».
  const reShip =
    /Универсальный\s+передаточный\s+документ\s+№\s*(\S+?)\s+от\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i;
  let docNumber: string | null = null;
  let docDate: string | null = null;
  for (const line of lines) {
    const m = reShip.exec(line);
    if (m && m[1] && m[2]) {
      docNumber = m[1];
      docDate = parseRuDate(m[2]);
      break;
    }
  }
  return { docNumber, docDate };
}

// ─── Поставщик и покупатель ────────────────────────────────────────────────

type Party = { inn: string | null; kpp: string | null; name: string | null };

function parseParties(lines: string[]): {
  supplier: Party | null;
  recipient: Party | null;
} {
  let supplierName: string | null = null;
  let recipientName: string | null = null;
  let supplierInn: string | null = null;
  let supplierKpp: string | null = null;
  let recipientInn: string | null = null;
  let recipientKpp: string | null = null;

  // Поля могут лежать на одной excel-строке (форма Б — старая 1С) или каждое
  // на своей (форма А — новая). Не выходим из цикла после первого совпадения,
  // потому что в форме Б Покупатель находится в той же строке, что и Продавец.
  for (const line of lines) {
    if (!supplierName) {
      const m = matchParty(line, /Продавец:\s*/, /\(2\)|Покупатель:|ИНН|Адрес:|Статус:/);
      if (m) supplierName = m;
    }
    if (!recipientName) {
      const m = matchParty(line, /Покупатель:\s*/, /\(6\)|ИНН|Адрес:|Валюта:/);
      if (m) recipientName = m;
    }
    if (!supplierInn) {
      const m = /ИНН\/КПП\s+продавца:?\s*(\d{10,12})(?:\s*\/\s*(\d{9}))?/i.exec(line);
      if (m && m[1]) {
        supplierInn = m[1];
        supplierKpp = m[2] ?? null;
      }
    }
    if (!recipientInn) {
      const m =
        /ИНН\/КПП\s+покупателя:?\s*(\d{10,12})(?:\s*\/\s*(\d{9}))?/i.exec(line);
      if (m && m[1]) {
        recipientInn = m[1];
        recipientKpp = m[2] ?? null;
      }
    }
  }

  const supplier = supplierInn || supplierName
    ? { inn: supplierInn, kpp: supplierKpp, name: supplierName }
    : null;
  const recipient = recipientInn || recipientName
    ? { inn: recipientInn, kpp: recipientKpp, name: recipientName }
    : null;
  return { supplier, recipient };
}

function matchParty(line: string, prefixRe: RegExp, terminatorAlt: RegExp): string | null {
  const startMatch = prefixRe.exec(line);
  if (!startMatch) return null;
  const tail = line.slice(startMatch.index + startMatch[0].length);
  const endMatch = terminatorAlt.exec(tail);
  const raw = (endMatch ? tail.slice(0, endMatch.index) : tail).trim();
  if (!raw) return null;
  return raw.replace(/\s*\(\d+[а-я]?\)\s*$/u, '').trim() || null;
}

// ─── Табличная часть ───────────────────────────────────────────────────────

// Графы УПД, которые нам нужны для извлечения позиций и итогов.
// Маркер «1а» (наименование) и «9» (стоимость с налогом) — главные.
type GraphKey = '1а' | '2а' | '3' | '4' | '5' | '7' | '8' | '9';
const REQUIRED_GRAPHS: readonly GraphKey[] = ['1а', '3', '5', '9'] as const;
const ALL_GRAPHS: readonly GraphKey[] = ['1а', '2а', '3', '4', '5', '7', '8', '9'] as const;

function findGraphMarkerRow(rows: RawRow[]): {
  index: number;
  graphCols: Map<GraphKey, number>;
} | null {
  // Ищем строку, где встречаются значения {1а, 2а, 3, 4, 5, 7, 8, 9} в
  // разных ячейках. Это строка с номерами граф (одинакова в обеих формах).
  // Допускаем, что не все номера попадут в одну строку — но «1а», «3», «5»,
  // «9» обязательны: без них нельзя извлечь позицию.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const found = new Map<GraphKey, number>();
    for (const [col, value] of row.cells) {
      const s = normCell(value).toLowerCase();
      for (const g of ALL_GRAPHS) {
        if (!found.has(g) && s === g.toLowerCase()) {
          found.set(g, col);
        }
      }
    }
    const hasAll = REQUIRED_GRAPHS.every((g) => found.has(g));
    if (hasAll) return { index: i, graphCols: found };
  }
  return null;
}

function isStopWord(s: string): boolean {
  const t = s.toLowerCase();
  return (
    t.startsWith('всего к оплате') ||
    t === 'всего' ||
    t.startsWith('итого') ||
    t.startsWith('документ составлен') ||
    t.startsWith('руководитель')
  );
}

function parseItemsAndTotals(rows: RawRow[]): {
  items: UpdPdfItem[];
  totalSum: number | null;
  vatSum: number | null;
  itemsCount: number | null;
} {
  const marker = findGraphMarkerRow(rows);
  if (!marker) {
    return { items: [], totalSum: null, vatSum: null, itemsCount: null };
  }
  const { graphCols } = marker;
  const colName = graphCols.get('1а')!;
  const colUnit = graphCols.get('2а') ?? null;
  const colQty = graphCols.get('3')!;
  const colPrice = graphCols.get('4') ?? null;
  // «5» — стоимость БЕЗ налога, «9» — стоимость С налогом. В контракт
  // мы кладём sum=стоимость С налогом (графа 9).
  const colSumWithTax = graphCols.get('9')!;
  const colVatRate = graphCols.get('7') ?? null;
  const colVatSum = graphCols.get('8') ?? null;

  const items: UpdPdfItem[] = [];
  let totalSum: number | null = null;
  let vatSum: number | null = null;

  for (let i = marker.index + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const nameCell = row.cells.get(colName);
    const firstColCell = [...row.cells.values()][0];
    const nameText = normCell(nameCell ?? '');
    const anyText = normCell(firstColCell ?? '');

    // Итог: ячейка с «Всего к оплате» в любой из ранних колонок таблицы.
    if (isStopWord(nameText) || isStopWord(anyText)) {
      totalSum = parseNum(row.cells.get(colSumWithTax) ?? null);
      if (colVatSum) vatSum = parseNum(row.cells.get(colVatSum) ?? null);
      break;
    }

    if (!nameText) continue; // подзаголовок / пустая строка

    const qty = parseNum(row.cells.get(colQty) ?? null);
    const sumWithTax = parseNum(row.cells.get(colSumWithTax) ?? null);
    // Подзаголовок с подписями «код», «условное обозначение» и т.п.
    // отсеиваем: у такой строки нет ни qty, ни sum.
    if (qty === null && sumWithTax === null) continue;

    if (qty === null) continue; // qty в схеме обязателен — пропускаем

    const price = colPrice !== null ? parseNum(row.cells.get(colPrice) ?? null) : null;
    const vatRate = colVatRate !== null ? parseVatRate(row.cells.get(colVatRate) ?? null) : null;
    const vatSumLine = colVatSum !== null ? parseNum(row.cells.get(colVatSum) ?? null) : null;

    let unit = '';
    if (colUnit !== null) unit = normCell(row.cells.get(colUnit) ?? '');
    if (!unit) unit = 'шт';

    // Многострочное наименование в 1С часто содержит дублирующий код товара
    // во второй строке («Розетка ...\n076551-SPL»). Берём только первую
    // непустую строку как название, остальное теряем (код всё равно лежит
    // в графе «Б», нам он не нужен в nameRaw).
    const nameRaw = nameText.replace(/\s+/g, ' ').trim();

    items.push({
      nameRaw,
      qty,
      unit,
      price: price ?? null,
      sum: sumWithTax ?? null,
      vatRate: vatRate ?? null,
      vatSum: vatSumLine ?? null,
      volumeM3: null,
      massKg: null,
      volumeConfidence: null,
      groupName: null,
    });
  }

  return {
    items,
    totalSum,
    vatSum,
    itemsCount: items.length > 0 ? items.length : null,
  };
}
