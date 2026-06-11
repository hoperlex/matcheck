import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';

// Локальный парсер УПД из xlsx (без LLM). Поддерживает две формы:
//   А — 1С/Элевел 2026 (новая редакция постановления 1137, графы 1–14 с
//       подграфами; поля шапки в одной ячейке: «Продавец: <name>»).
//   Б — 1С 2021 (старая форма, графы 1–11; поля шапки разнесены по соседним
//       ячейкам той же строки: «Продавец:» + «<name>», далее «Покупатель:»
//       + «<name>» в той же строке).
//
// Стратегия: для каждой строки worksheet склеиваем все непустые ячейки через
// пробел → получаем «линию текста», совместимую с регулярками для PDF.
// Шапка извлекается регулярками, items в этом шаге не парсятся (будет в 2b).
//
// Используем ExcelJS streaming WorkbookReader — он НЕ вызывает reconcile,
// который в нестриминговом xlsx.load() падает с TypeError на 1С-выгрузках
// (баг ExcelJS 4.4: в model.drawings регистрируются имена без объектов).
// Стриминг устойчив к таким файлам и быстрее: ячейки идут потоком, без
// построения полной model в памяти.

export async function parseUpdXlsx(buffer: Buffer): Promise<UpdPdfParsed> {
  const lines = await collectLines(buffer);

  const { docNumber, docDate } = parseDocHeader(lines);
  const { supplier, recipient } = parseParties(lines);

  const filled = [
    docNumber !== null,
    docDate !== null,
    supplier?.inn !== undefined && supplier?.inn !== null,
    supplier?.name !== undefined && supplier?.name !== null,
    recipient?.inn !== undefined && recipient?.inn !== null,
    recipient?.name !== undefined && recipient?.name !== null,
  ].filter(Boolean).length;
  // 0 заполненных полей → 0; 6/6 → 0.85. Items не парсятся на этом шаге,
  // поэтому максимум 0.85, не 0.95 (worker'у это нормально — фронт всё равно
  // покажет «низкая уверенность», пользователь добавит позиции вручную).
  const confidence = filled === 0 ? 0 : Math.min(0.85, 0.25 + filled * 0.1);

  const parsed: UpdPdfParsed = {
    docNumber,
    docDate,
    totalSum: null,
    vatSum: null,
    itemsCount: null,
    supplier,
    recipient,
    items: [],
    confidence,
  };
  return UpdPdfParsedSchema.parse(parsed);
}

// ─── Сбор строк ────────────────────────────────────────────────────────────

async function collectLines(buffer: Buffer): Promise<string[]> {
  const stream = Readable.from(buffer);
  // sharedStrings: 'cache' нужен для УПД из 1С — там >100 общих строк, без
  // кэша при стриминге cell.value придёт как индекс, а не текст.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
  });

  const lines: string[] = [];
  let firstSheetDone = false;
  for await (const ws of reader) {
    if (firstSheetDone) break;
    for await (const row of ws) {
      const parts: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const s = cellToString(cell.value);
        if (s) parts.push(s);
      });
      if (parts.length === 0) continue;
      // Склейка ячеек одной excel-строки через пробел. Внутренние \n
      // (многострочные ячейки) сворачиваем в пробел — для регулярок шапки
      // переносы не нужны.
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    firstSheetDone = true;
  }
  return lines;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // RichText
    if ('richText' in v && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
      return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    // Formula с результатом — берём результат
    if ('result' in v && (v as ExcelJS.CellFormulaValue).result !== undefined) {
      const r = (v as ExcelJS.CellFormulaValue).result;
      if (r === null || r === undefined) return '';
      if (typeof r === 'string') return r;
      if (typeof r === 'number') return String(r);
      if (r instanceof Date) return r.toISOString().slice(0, 10);
      return '';
    }
    // Hyperlink — берём text
    if ('text' in v) {
      const t = (v as ExcelJS.CellHyperlinkValue).text;
      return typeof t === 'string' ? t : '';
    }
    // Error — пусто
    if ('error' in v) return '';
  }
  return '';
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
  // Ищем «Продавец: <name>» где <name> заканчивается перед маркером (2)/«Покупатель:»/
  // «ИНН/КПП»/«Адрес:» или концом строки. Это покрывает оба варианта:
  //  - «Продавец: ООО "А" (2)» — обрезается до «ООО "А"».
  //  - «Продавец: ООО "А" (2) Покупатель: ООО "Б" (6)» — обрезается до «ООО "А"».
  const startMatch = prefixRe.exec(line);
  if (!startMatch) return null;
  const tail = line.slice(startMatch.index + startMatch[0].length);
  const endMatch = terminatorAlt.exec(tail);
  const raw = (endMatch ? tail.slice(0, endMatch.index) : tail).trim();
  if (!raw) return null;
  // Уберём хвостовые скобочные маркеры вроде « (2)» если они «приклеились» к имени
  // без пробела.
  return raw.replace(/\s*\(\d+[а-я]?\)\s*$/u, '').trim() || null;
}
