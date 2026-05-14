import { PDFParse } from 'pdf-parse';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { PdfNoTextError, type ParsePdfResult } from './upd-pdf.parser.js';

const MIN_TEXT_LENGTH = 200;

// Локальный парсер УПД-PDF без LLM. Работает на печатной форме УПД из
// постановления Правительства РФ № 1137 (та же шапка, маркеры (2б)/(6б),
// табличная строка с признаком «Без акциза»). Поддерживает 1С и iText-генераторы.
// Возвращает items: [] и confidence: 0, если ни одна позиция не распознана —
// тогда клиент предложит ре-распознать через LLM.

export async function parseUpdPdfLocal(buffer: Buffer): Promise<ParsePdfResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (clean.length < MIN_TEXT_LENGTH) {
    throw new PdfNoTextError(clean.length);
  }
  const parsed = parseUpdText(clean);
  return {
    parsed,
    textLength: clean.length,
    llmProviderId: null,
  };
}

const VALID_NUM_RE = /^\d{1,3}(?:\s\d{3})*(?:[.,]\d+)?$/;

function parseRu(s: string): number {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

function parseDateRu(dmy: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(dmy);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  let year = m[3];
  if (year.length === 2) year = `20${year}`;
  return `${year}-${month}-${day}`;
}

function parseVatRate(s: string): number | null {
  if (/без/i.test(s)) return 0;
  const m = /(\d+(?:[.,]\d+)?)/.exec(s);
  return m && m[1] ? parseRu(m[1]) : null;
}

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}

// Разбивает строку с N числами на ровно `count` частей. Учитывает русский
// формат «1 992.33» (пробел как разделитель тысяч). При неоднозначности
// выбирает разбиение, лучше всего удовлетворяющее арифметической связи
// (для count=3: qty*price ≈ sum). Возвращает null, если ни одно разбиение
// не валидно.
function partitionNumbers(s: string, count: number): number[] | null {
  const tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < count) return null;
  const partitions: string[][][] = [];

  function gen(start: number, partsSoFar: string[][], remaining: number): void {
    if (remaining === 0) {
      if (start === tokens.length) {
        partitions.push(partsSoFar.map((p) => p.slice()));
      }
      return;
    }
    const maxEnd = tokens.length - (remaining - 1);
    for (let end = start + 1; end <= maxEnd; end++) {
      const slice = tokens.slice(start, end);
      const joined = slice.join(' ');
      if (!VALID_NUM_RE.test(joined)) continue;
      partsSoFar.push(slice);
      gen(end, partsSoFar, remaining - 1);
      partsSoFar.pop();
    }
  }
  gen(0, [], count);
  if (partitions.length === 0) return null;

  const candidates: number[][] = partitions.map((parts) =>
    parts.map((slice) => parseRu(slice.join(' '))),
  );
  if (candidates.length === 1) return candidates[0] ?? null;

  if (count === 3) {
    candidates.sort((a, b) => score3(a) - score3(b));
  }
  return candidates[0] ?? null;
}

function score3(nums: number[]): number {
  const q = nums[0] ?? 0;
  const p = nums[1] ?? 0;
  const s = nums[2] ?? 0;
  if (s > 0) return Math.abs(q * p - s) / s;
  return Infinity;
}

// Парсит строку данных позиции после «<unit_code> <unit_name>».
// Возвращает { unit, qty, price, sum, vatRate, vatSum, sumWithVat } или null.
function parseItemDataLine(line: string): {
  unit: string;
  qty: number;
  price: number;
  sum: number;
  vatRate: number | null;
  vatSum: number;
  sumWithVat: number;
} | null {
  // Разделитель «Без акциза» (для УПД иногда «без акциза»).
  // Без \b — он в JS regex работает только по ASCII-word-границам.
  const split = line.split(/Без\s+акциза/i);
  if (split.length !== 2) return null;
  const headStr = split[0] ?? '';
  const tailStr = split[1] ?? '';

  // Head: <unit_code 3 цифры> <unit_name> + 3 числа (qty, price, sum_no_vat).
  const headM = /^\s*(\d{3})\s+(\S+)\s+(.+?)\s*$/.exec(headStr);
  if (!headM || !headM[2] || !headM[3]) return null;
  const unit = headM[2];
  const headNums = partitionNumbers(headM[3], 3);
  if (!headNums || headNums.length !== 3) return null;
  const [qty, price, sum] = headNums as [number, number, number];

  // Tail: <vat_rate> <vat_sum> <sum_with_vat> [<country_code 3 цифры> <country_name>]
  const tailM = /^\s*(\d{1,2}(?:[.,]\d+)?%|без\s*НДС)\s+(.+?)\s*$/i.exec(tailStr);
  if (!tailM || !tailM[1] || !tailM[2]) return null;
  const vatRate = parseVatRate(tailM[1]);
  let rest = tailM[2].trim();
  // Уберём хвостовой код страны и название (например, «643 Россия» или «112 Беларусь»).
  rest = rest.replace(/\s+\d{3}\s+[\p{L}][\p{L}\s\-]*$/u, '').trim();
  const tailNums = partitionNumbers(rest, 2);
  if (!tailNums || tailNums.length !== 2) return null;
  const [vatSum, sumWithVat] = tailNums as [number, number];

  return { unit, qty, price, sum, vatRate, vatSum, sumWithVat };
}

export function parseUpdText(text: string): UpdPdfParsed {
  const lines = text.split('\n');

  // ─── Шапка ──────────────────────────────────────────────────────────────
  let docNumber: string | null = null;
  let docDate: string | null = null;
  const numDateRe = /Сч[её]т-фактура\s+№\s+(\S+)\s+от\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i;
  for (const line of lines) {
    const m = numDateRe.exec(line);
    if (m && m[1] && m[2]) {
      docNumber = clean(m[1]);
      docDate = parseDateRu(m[2]);
      break;
    }
  }

  // Продавец / Покупатель — название (single-line, c опциональным тегом «(2)» / «(6)»).
  let supplierName: string | null = null;
  let recipientName: string | null = null;
  for (const line of lines) {
    if (!supplierName) {
      const m = /^Продавец\s+(.+?)(?:\s*\(2\))?$/.exec(line);
      if (m?.[1]) supplierName = clean(m[1]);
    }
    if (!recipientName) {
      const m = /^Покупатель\s+(.+?)(?:\s*\(6\))?$/.exec(line);
      if (m?.[1]) recipientName = clean(m[1]);
    }
    if (supplierName && recipientName) break;
  }

  // ИНН/КПП: маркер (2б) — поставщик, (6б) — получатель.
  let supplierInn: string | null = null;
  let supplierKpp: string | null = null;
  let recipientInn: string | null = null;
  let recipientKpp: string | null = null;
  const innRe = /ИНН\/КПП\s+(\d{10,12})\s*\/\s*(\d{9})?/;
  const allInn: { inn: string; kpp: string | null; tag: string | null }[] = [];
  for (const line of lines) {
    const m = innRe.exec(line);
    if (!m || !m[1]) continue;
    const tagM = /\((2б|6б)\)/.exec(line);
    allInn.push({ inn: m[1], kpp: m[2] ?? null, tag: tagM?.[1] ?? null });
  }
  for (const e of allInn) {
    if (e.tag === '2б' && !supplierInn) {
      supplierInn = e.inn;
      supplierKpp = e.kpp;
    } else if (e.tag === '6б' && !recipientInn) {
      recipientInn = e.inn;
      recipientKpp = e.kpp;
    }
  }
  if (!supplierInn && allInn[0]) {
    supplierInn = allInn[0].inn;
    supplierKpp = allInn[0].kpp;
  }
  if (!recipientInn) {
    const second = allInn.find((e) => e.inn !== supplierInn);
    if (second) {
      recipientInn = second.inn;
      recipientKpp = second.kpp;
    }
  }

  // ─── Итоги ──────────────────────────────────────────────────────────────
  let totalSum: number | null = null;
  let vatSum: number | null = null;
  const NUM = String.raw`\d{1,3}(?:\s\d{3})*(?:[.,]\d+)?`;
  const totalRe = new RegExp(
    String.raw`Всего\s+к\s+оплате\s*\(9\)\s+(${NUM})\s+x\s+x\s+(${NUM})\s+(${NUM})`,
    'i',
  );
  for (const line of lines) {
    const m = totalRe.exec(line);
    if (m && m[2] && m[3]) {
      vatSum = parseRu(m[2]);
      totalSum = parseRu(m[3]);
      break;
    }
  }

  // Кол-во позиций из шапки/футера (для серверной сверки с items.length).
  // Типовые формулировки: «Всего наименований N», «Количество позиций N»,
  // «Итого N наименований». Если не нашли — null, проверка items_count skip.
  let itemsCount: number | null = null;
  const countRes: RegExp[] = [
    /Всего\s+наименований[\s:]+(\d+)/i,
    /Количество\s+позиций[\s:]+(\d+)/i,
    /Кол-во\s+позиций[\s:]+(\d+)/i,
    /Итого\s+(\d+)\s+наименован/i,
  ];
  for (const line of lines) {
    for (const re of countRes) {
      const m = re.exec(line);
      if (m && m[1]) {
        itemsCount = Number(m[1]);
        break;
      }
    }
    if (itemsCount !== null) break;
  }

  // ─── Таблица позиций ────────────────────────────────────────────────────
  // Якорь начала: строка-легенда «А 1 1a 1б 2 ...» (А кириллица).
  // Якорь конца: «Всего к оплате».
  const itemsHeaderIdx = lines.findIndex((l) =>
    /^А\s+1\s+1\S+\s+1\S+\s+2/.test(l.trim()),
  );
  let endIdx = lines.findIndex(
    (l, i) => i > Math.max(itemsHeaderIdx, 0) && /Всего\s+к\s+оплате/.test(l),
  );
  if (endIdx === -1) endIdx = lines.length;

  const items: UpdPdfParsed['items'] = [];
  if (itemsHeaderIdx !== -1) {
    // Старт позиции: <код ≥7 символов или с дефисом> <ожидаемый № п/п> <начало_наименования>.
    const startRe =
      /^([A-Za-zА-Яа-я0-9][A-Za-zА-Яа-я0-9\-./_]{5,}|[A-Za-zА-Яа-я0-9\-./_]*-[A-Za-zА-Яа-я0-9\-./_]+)\s+(\d{1,3})\s+(\S.+)$/;

    type Cur = { lineNo: number; nameParts: string[] };
    let cur: Cur | null = null;
    let expectedLineNo = 1;

    const flushItem = (
      data: ReturnType<typeof parseItemDataLine>,
      curRef: Cur | null,
    ): void => {
      if (!data || !curRef) return;
      const nameRaw = curRef.nameParts.join(' ').replace(/\s+/g, ' ').trim();
      if (nameRaw.length === 0) return;
      items.push({
        nameRaw,
        qty: data.qty,
        unit: data.unit || 'шт',
        price: data.price,
        sum: data.sum,
        vatRate: data.vatRate,
        vatSum: data.vatSum,
      });
    };

    for (let i = itemsHeaderIdx + 1; i < endIdx; i++) {
      const raw = lines[i] ?? '';
      const line = raw.trim();
      if (!line) continue;
      // Артефакты страниц и метаданные.
      if (/^Передан через Диадок/.test(line)) continue;
      if (/^Страница\s+\d+\s+из\s+\d+/.test(line)) continue;
      if (/^-- \d+ of \d+ --/.test(line)) continue;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) continue;
      if (/^Для1С_/.test(line)) continue;
      if (/^ИД:/.test(line)) continue;
      if (/^штрихкод:/i.test(line)) continue;

      // 1) Строка данных позиции — если совпала, закрываем cur и идём дальше.
      const data = parseItemDataLine(line);
      if (data && cur) {
        flushItem(data, cur);
        cur = null;
        expectedLineNo++;
        continue;
      }

      // 2) Старт следующей позиции — только если номер совпадает с ожидаемым
      //    (это отсекает строки-продолжения с псевдо-кодом вроде «SOLID 500 ...»).
      const startM = startRe.exec(line);
      if (startM && startM[2] && startM[3] && Number(startM[2]) === expectedLineNo) {
        cur = { lineNo: expectedLineNo, nameParts: [startM[3]] };
        continue;
      }

      // 3) Иначе — продолжение наименования.
      if (cur) cur.nameParts.push(line);
    }
  }

  // ─── Confidence ─────────────────────────────────────────────────────────
  let confidence = 0;
  if (items.length > 0) {
    const features = [
      docNumber !== null,
      docDate !== null,
      totalSum !== null,
      supplierInn !== null,
      recipientInn !== null,
      supplierName !== null,
      true,
    ];
    const filled = features.filter(Boolean).length;
    confidence = Math.min(0.95, Math.max(0.3, filled / features.length));
  }

  const parsed: UpdPdfParsed = {
    docNumber,
    docDate,
    totalSum,
    vatSum,
    itemsCount,
    supplier:
      supplierInn || supplierName
        ? { inn: supplierInn, kpp: supplierKpp, name: supplierName }
        : null,
    recipient:
      recipientInn || recipientName
        ? { inn: recipientInn, kpp: recipientKpp, name: recipientName }
        : null,
    items,
    confidence,
  };

  return UpdPdfParsedSchema.parse(parsed);
}
