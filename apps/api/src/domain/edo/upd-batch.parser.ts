// Multi-UPD PDF (несколько УПД в одном файле-скане) — ЧИСТЫЕ функции Шага 1.
//
// Это proof-слой: ни БД, ни сохранения, ни изменения production-flow
// parseUpdVision. Здесь только две детерминированные функции:
//
//   1. segmentUpdPages   — режет выбранные prefilter'ом страницы на группы
//      «одна группа = один УПД» по границам upd_main.
//   2. aggregateUpdDocuments — сворачивает массив распознанных УПД в ОДИН
//      агрегированный результат (номера через запятую, суммы, merged items)
//      с метаданными subdocs (какая позиция/страница из какого УПД).
//
// Расчёт на будущее: позже worker сохранит агрегат как ОДНУ source_document
// (kind='upd') c metadata.subdocs, а в «Документах» получится одна строка
// «487, 488, 489, 490». Сейчас НИЧЕГО из этого не сохраняем.

import type { PageClassification, PageType } from './upd-page-prefilter.js';
import type { UpdPdfParsed, UpdPdfItem } from '@matcheck/contracts';

// ─────────────────────────────── Сегментация ───────────────────────────────

export type SegmentConfidence =
  // открыта страницей upd_main, дополнялась только upd_continuation
  | 'normal'
  // создана защитно, чтобы не потерять selected-страницу без своего upd_main
  | 'fallback'
  // в группу попала неожиданная/неоднозначная страница (other/неизвестная/
  // certificate/накладная) — извлекать можно, но результат под вопросом
  | 'uncertain';

export type UpdPageSegment = {
  segmentIndex: number;
  // 1-based номера страниц этого УПД, в порядке возрастания
  pages: number[];
  confidence: SegmentConfidence;
  reasons: string[];
};

/**
 * Группирует страницы в УПД-документы по границам upd_main.
 *
 * Принцип «лучше uncertain/partial, чем потерять страницу»:
 *  - upd_main           → открывает новую группу (normal);
 *  - upd_continuation   → дополняет текущую; если текущей нет — создаёт
 *                         защитную fallback-группу (continuation без main);
 *  - other/неизвестная  → если есть текущая, прикрепляется к ней и помечает
 *                         её uncertain; если нет — открывает fallback-группу;
 *  - transport_waybill / certificate — обычно отсеяны prefilter'ом и сюда не
 *                         попадают; но если страница всё же выбрана —
 *                         НЕ выбрасываем её молча, а прикрепляем как uncertain.
 *
 * @param classification классификация ВСЕХ отрендеренных страниц (1-based page).
 * @param selectedPages  опционально — какие страницы реально идут на extract
 *   (selectedPages из PrefilterResult). Если не передан — берём страницы,
 *   помеченные `use:true` в классификации. Если страница есть в selectedPages,
 *   но отсутствует в классификации — она всё равно сегментируется (как unknown),
 *   чтобы не потеряться.
 */
export function segmentUpdPages(
  classification: PageClassification[],
  selectedPages?: number[],
): UpdPageSegment[] {
  const typeByPage = new Map<number, PageType>();
  for (const c of classification) typeByPage.set(c.page, c.type);

  // Набор страниц для сегментации.
  const rawPages =
    selectedPages ??
    classification.filter((c) => c.use).map((c) => c.page);
  // Уникальные, по возрастанию — сегментация идёт строго в порядке страниц.
  const pages = Array.from(new Set(rawPages)).sort((a, b) => a - b);

  const segments: UpdPageSegment[] = [];
  let current: UpdPageSegment | null = null;

  // Создаёт сегмент, кладёт в массив и ВОЗВРАЩАЕТ его — присваивание current
  // делает вызывающий код в теле цикла, чтобы TS видел сужение типа
  // (присваивание только внутри замыкания ломает control-flow analysis).
  const open = (page: number, confidence: SegmentConfidence, reason: string): UpdPageSegment => {
    const seg: UpdPageSegment = {
      segmentIndex: segments.length,
      pages: [page],
      confidence,
      reasons: [reason],
    };
    segments.push(seg);
    return seg;
  };
  const markUncertain = (seg: UpdPageSegment, reason: string): void => {
    if (seg.confidence === 'normal') seg.confidence = 'uncertain';
    seg.reasons.push(reason);
  };

  for (const page of pages) {
    const type = typeByPage.get(page); // PageType | undefined
    if (type === 'upd_main') {
      current = open(page, 'normal', 'opened_by_upd_main');
      continue;
    }
    if (type === 'upd_continuation') {
      if (current) {
        current.pages.push(page);
        current.reasons.push(`continuation_page_${page}`);
      } else {
        current = open(page, 'fallback', 'continuation_without_main');
      }
      continue;
    }
    // other / certificate / transport_waybill / unknown(undefined)
    const label = type ?? 'unknown';
    if (current) {
      current.pages.push(page);
      markUncertain(current, `attached_${label}_page_${page}`);
    } else {
      current = open(page, 'fallback', `opened_by_${label}_page`);
    }
  }

  // segmentIndex уже проставлен при open() и совпадает с позицией в массиве.
  return segments;
}

// ─────────────────────────────── Агрегация ─────────────────────────────────

/** Распознанный один УПД из группы страниц + привязка к сегменту. */
export type ParsedUpdSubdocument = UpdPdfParsed & {
  pages: number[];
  segmentIndex: number;
};

/** Метаданные одного УПД внутри агрегата (для будущего metadata.subdocs). */
export type AggregatedSubdocMeta = {
  segmentIndex: number;
  docNumber: string | null;
  docDate: string | null;
  pages: number[];
  totalSum: number | null;
  vatSum: number | null;
  // фактическое число позиций, которые этот УПД внёс в общий список
  itemsCount: number;
  // 1-based позиции этих позиций в объединённом items[] — провенанс
  // «строка материала ← какой УПД» без отдельного поля lineNo на item.
  itemLineNos: number[];
  confidence: number;
};

/** Агрегированный результат: один УПД-эквивалент для одной строки в «Документы». */
export type AggregatedUpdDocument = {
  docNumber: string | null; // "487, 488, 489, 490"
  docDate: string | null;
  totalSum: number | null;
  vatSum: number | null;
  itemsCount: number;
  supplier: UpdPdfParsed['supplier'];
  recipient: UpdPdfParsed['recipient'];
  items: UpdPdfItem[];
  confidence: number;
  subdocs: AggregatedSubdocMeta[];
  reasons: string[];
};

type Party = NonNullable<UpdPdfParsed['supplier']>;

function partyKey(p: UpdPdfParsed['supplier']): string | null {
  if (p == null) return null;
  const inn = p.inn ?? '';
  const kpp = p.kpp ?? '';
  const name = (p.name ?? '').trim();
  if (!inn && !kpp && !name) return null;
  return `${inn}|${kpp}|${name}`;
}

// Сумма non-null значений; если ВСЕХ значений нет — null (а не 0 и не NaN).
function sumNonNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/**
 * Сворачивает распознанные УПД в один агрегированный результат.
 *
 * Порядок документов — по первой странице (канонично по порядку страниц).
 * Ничего не сохраняет; metadata.subdocs возвращается прямо в результате.
 *
 * Пустой список — это ошибка вызова (нет УПД для агрегации): бросаем явно,
 * чтобы caller (worker в будущем) обработал «не нашли УПД» отдельной веткой,
 * а не получил молча пустой документ.
 */
export function aggregateUpdDocuments(
  documents: ParsedUpdSubdocument[],
): AggregatedUpdDocument {
  if (documents.length === 0) {
    throw new Error('aggregateUpdDocuments: пустой список документов');
  }

  // Канонический порядок — по минимальной странице субдокумента.
  const firstPage = (d: ParsedUpdSubdocument): number =>
    d.pages.length ? Math.min(...d.pages) : Number.MAX_SAFE_INTEGER;
  const ordered = [...documents].sort((a, b) => firstPage(a) - firstPage(b));

  const reasons: string[] = [];
  const items: UpdPdfItem[] = [];
  const subdocs: AggregatedSubdocMeta[] = [];

  for (const d of ordered) {
    const startLine = items.length + 1; // 1-based позиция первой позиции этого УПД
    items.push(...d.items);
    const itemLineNos: number[] = [];
    for (let i = 0; i < d.items.length; i++) itemLineNos.push(startLine + i);

    subdocs.push({
      segmentIndex: d.segmentIndex,
      docNumber: d.docNumber ?? null,
      docDate: d.docDate ?? null,
      pages: d.pages,
      totalSum: d.totalSum ?? null,
      vatSum: d.vatSum ?? null,
      itemsCount: d.items.length,
      itemLineNos,
      confidence: d.confidence,
    });
  }

  // docNumber — номера через запятую в порядке страниц.
  const numbers = ordered
    .map((d) => d.docNumber?.trim())
    .filter((n): n is string => !!n && n.length > 0);
  const docNumber = numbers.length ? numbers.join(', ') : null;

  // docDate — общая, если все одинаковые; иначе первая по порядку страниц.
  const dates = ordered
    .map((d) => d.docDate?.trim())
    .filter((s): s is string => !!s && s.length > 0);
  const uniqueDates = Array.from(new Set(dates));
  let docDate: string | null = null;
  if (uniqueDates.length === 1) {
    docDate = uniqueDates[0]!;
  } else if (uniqueDates.length > 1) {
    docDate = dates[0]!; // первая по порядку страниц
    reasons.push('multiple_doc_dates');
  }

  const totalSum = sumNonNull(ordered.map((d) => d.totalSum));
  const vatSum = sumNonNull(ordered.map((d) => d.vatSum));

  // supplier/recipient — общий, если совпадают; иначе первый non-null + reason.
  const resolveParty = (
    pick: (d: ParsedUpdSubdocument) => UpdPdfParsed['supplier'],
    label: string,
  ): UpdPdfParsed['supplier'] => {
    const parties = ordered.map(pick).filter((p): p is Party => partyKey(p) != null);
    if (parties.length === 0) return null;
    const keys = new Set(parties.map((p) => partyKey(p)!));
    if (keys.size > 1) reasons.push(`multiple_${label}`);
    return parties[0]!;
  };
  const supplier = resolveParty((d) => d.supplier, 'suppliers');
  const recipient = resolveParty((d) => d.recipient, 'recipients');

  // confidence — консервативно минимум по субдокументам.
  const confidence = Math.min(...ordered.map((d) => d.confidence));

  return {
    docNumber,
    docDate,
    totalSum,
    vatSum,
    itemsCount: items.length,
    supplier,
    recipient,
    items,
    confidence,
    subdocs,
    reasons,
  };
}
