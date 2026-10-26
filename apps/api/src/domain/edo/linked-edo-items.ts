/**
 * Строки привязанной к приёмке УПД из ЭДО — для показа в блоке материалов.
 *
 * Снимка в БД нет намеренно: строки разбираются из XML реестра при каждом
 * открытии карточки тем же путём, что и PDF (`buildExportPdf` в
 * routes/delivery-edo.ts), с теми же пределами. Поэтому таблица в карточке и
 * «Открыть файл» показывают одно и то же по построению, а смена парсера не
 * разводит их.
 *
 * Ничего не пишет: позиции приёмки (`delivery_items`) — это факт инспектора,
 * строки ЭДО живут отдельным слоем и в него не переносятся.
 *
 * Сбои документа — значение `state`, а не исключение: в карточке у каждой УПД
 * своё состояние, и сбой одной не должен прятать соседние.
 */
import { asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { sourceDocumentItems } from '../../db/schema.js';
import { getObject } from '../storage/s3.signer.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { assessUpdItems, parseUpdXml, type UpdParsed } from './upd.parser.js';
import { UPD_PDF_MAX_ITEMS, UPD_PDF_MAX_XML_BYTES } from './upd-review-pdf.js';

/**
 * Срок на чтение одной УПД из хранилища — вместе с повторами и паузами. Без
 * него `getObject` ждёт до 3 × 60 с, и карточка висела бы на «Загружаю…».
 */
export const EDO_ITEMS_DEADLINE_MS = 15_000;

export type LinkedEdoItemsState =
  | 'ready'
  | 'incomplete'
  | 'storage_failed'
  | 'parse_failed'
  | 'too_large';

export type LinkedEdoItem = {
  /** Порядок строки в документе — ключ показа, не долговременная ссылка. */
  position: number;
  lineNo: number | null;
  nameRaw: string;
  qty: number;
  unit: string | null;
  unitCode: string | null;
  /** Цена за единицу без НДС. */
  price: number | null;
  sumExVat: number | null;
  vatRate: number | null;
  vatSum: number | null;
  /** Стоимость строки с НДС. */
  sum: number | null;
  /** ПрТовРаб: 1 — имущество, 2 — работа, 3 — услуга, 4 — права, 5 — иное. */
  itemKind: number | null;
  productCode: string | null;
};

/** null у поля — «неизвестно», нулём не считается. */
export type LinkedEdoTotals = {
  totalSum: number | null;
  totalExVat: number | null;
  vatSum: number | null;
};

export type LinkedEdoItemsResult = {
  state: LinkedEdoItemsState;
  /** null — разбора нет (сбой чтения, разбора или предел). */
  totals: LinkedEdoTotals | null;
  reasons: string[];
  items: LinkedEdoItem[];
};

const failed = (
  state: Exclude<LinkedEdoItemsState, 'ready' | 'incomplete'>,
  reasons: string[] = [],
): LinkedEdoItemsResult => ({ state, totals: null, reasons, items: [] });

function fromParsed(parsed: UpdParsed): LinkedEdoItemsResult {
  const reasons = assessUpdItems(parsed);
  return {
    state: reasons.length ? 'incomplete' : 'ready',
    totals: { totalSum: parsed.totalSum, totalExVat: parsed.totalExVat, vatSum: parsed.vatSum },
    reasons,
    items: parsed.items.map((item, position) => ({
      position,
      lineNo: Number.isFinite(item.lineNo) ? item.lineNo : null,
      nameRaw: item.nameRaw,
      qty: item.qty,
      unit: item.unit || null,
      unitCode: item.unitCode,
      price: item.price,
      sumExVat: item.sumExVat,
      vatRate: item.vatRate,
      vatSum: item.vatSum,
      sum: item.sum,
      itemKind: item.kind,
      productCode: item.productCode,
    })),
  };
}

/** Строка реестра — ровно то, что нужно для чтения её файла. */
export type ExportItemsSource = {
  id: string;
  status: string;
  s3Key: string | null;
  sizeBytes: number | null;
};

/**
 * Строки УПД из реестра: S3 → разбор → оценка полноты.
 *
 * Пределы и проверки — те же, что у PDF: размер по реестру ДО чтения (объект
 * держится в памяти целиком) и ещё раз после, число строк после разбора.
 */
export async function readExportItems(
  doc: ExportItemsSource,
  opts: { log: FastifyBaseLogger; deadlineMs?: number },
): Promise<LinkedEdoItemsResult> {
  const { log } = opts;
  // Привязка требует stored и ключ, а строку реестра держит RESTRICT: сюда
  // такое не доходит. Если дошло — это нарушение, а не сбой хранилища.
  if (doc.status !== 'stored' || !doc.s3Key) {
    log.error({ documentId: doc.id, status: doc.status }, 'edo items: linked document not stored');
    return failed('storage_failed');
  }
  // Как у PDF: пустой размер — аномалия, вслепую не читаем.
  if (doc.sizeBytes === null) return failed('too_large', ['размер файла в реестре не указан']);
  if (doc.sizeBytes > UPD_PDF_MAX_XML_BYTES) return failed('too_large');

  let buffer: Buffer;
  try {
    buffer = await getObject(doc.s3Key, {
      signal: AbortSignal.timeout(opts.deadlineMs ?? EDO_ITEMS_DEADLINE_MS),
    });
  } catch (err) {
    log.warn({ err, documentId: doc.id }, 'edo items: s3 read failed');
    return failed('storage_failed');
  }
  // Размер уже сверен по реестру, но строка реестра могла разойтись с объектом.
  if (buffer.length > UPD_PDF_MAX_XML_BYTES) return failed('too_large');

  let parsed: UpdParsed;
  try {
    parsed = parseUpdXml(decodeXmlBuffer(buffer));
  } catch (err) {
    log.warn({ err, documentId: doc.id }, 'edo items: xml parse failed');
    return failed('parse_failed');
  }
  if (parsed.items.length > UPD_PDF_MAX_ITEMS) return failed('too_large');
  return fromParsed(parsed);
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Строки импортированной карточки Диадока — из базы, без S3.
 *
 * Полей формата (сумма без НДС, код ОКЕИ, ПрТовРаб, код товара) у позиций
 * карточки нет — они null. id позиций карточки нестабильны (правка карточки
 * пересоздаёт их), поэтому `position` здесь — только порядок показа.
 */
export async function readImportedItems(
  db: Pick<Db, 'select'>,
  sourceDocumentId: string,
  totals: { totalSum: string | null; vatSum: string | null },
): Promise<LinkedEdoItemsResult> {
  const rows = await db
    .select({
      lineNo: sourceDocumentItems.lineNo,
      nameRaw: sourceDocumentItems.nameRaw,
      qty: sourceDocumentItems.qty,
      unit: sourceDocumentItems.unit,
      price: sourceDocumentItems.price,
      sum: sourceDocumentItems.sum,
      vatRate: sourceDocumentItems.vatRate,
      vatSum: sourceDocumentItems.vatSum,
    })
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId))
    .orderBy(asc(sourceDocumentItems.lineNo), asc(sourceDocumentItems.id));
  const reasons = assessUpdItems({
    items: rows.map((row) => ({ qty: toNumber(row.qty) ?? 0, sum: toNumber(row.sum) })),
  });
  return {
    state: reasons.length ? 'incomplete' : 'ready',
    totals: {
      totalSum: toNumber(totals.totalSum),
      totalExVat: null,
      vatSum: toNumber(totals.vatSum),
    },
    reasons,
    items: rows.map((row, position) => ({
      position,
      lineNo: row.lineNo,
      nameRaw: row.nameRaw,
      qty: toNumber(row.qty) ?? 0,
      unit: row.unit || null,
      unitCode: null,
      price: toNumber(row.price),
      sumExVat: null,
      vatRate: toNumber(row.vatRate),
      vatSum: toNumber(row.vatSum),
      sum: toNumber(row.sum),
      itemKind: null,
      productCode: null,
    })),
  };
}
