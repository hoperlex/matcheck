/**
 * Какие документы ящика — УПД с материалами, а какие нет.
 *
 * В ящике лежит всё подряд: счета, акты, договоры, письма, УПД на работы и
 * услуги. В портал должны попадать только УПД, по которым на объект приехали
 * материалы. Решение принимается в два шага, и у каждого есть причина —
 * она попадает в журнал и в отчёт, чтобы на вопрос «а где документ?» был ответ.
 *
 *   1. По метаданным, без скачивания: тип, функция, признаки теста и
 *      аннулирования. Счёт-фактура, акт или скан отсеиваются здесь.
 *   2. По содержимому УПД: признак предмета каждой позиции (`ПрТовРаб`). Хотя
 *      бы одна позиция-имущество — материалы (смешанный УПД берётся целиком:
 *      доставка остаётся его строкой). Все позиции — работы или услуги — не
 *      берём. Признак не заполнен — смотрим косвенные признаки, а если они
 *      противоречат друг другу, честно говорим «не определено».
 */
import type { UpdItemKind, UpdParsed } from './upd.parser.js';

/** Функции УПД, при которых документ передаёт товар. `СЧФ` — только счёт-фактура. */
export const MATERIAL_FUNCTIONS = new Set(['СЧФДОП', 'ДОП']);

const UTD = 'UniversalTransferDocument';
const INVOICE_TYPES = new Set([
  'Invoice',
  'InvoiceRevision',
  'InvoiceCorrection',
  'InvoiceCorrectionRevision',
]);
const REVISION_TYPES = new Set(['UniversalTransferDocumentRevision']);
const CORRECTION_TYPES = new Set([
  'UniversalCorrectionDocument',
  'UniversalCorrectionDocumentRevision',
]);
const WAYBILL_TYPES = new Set(['XmlTorg12', 'Torg12', 'TovTorg551', 'TovTorg']);
const NONFORMALIZED = 'Nonformalized';

export type EdoMetaCategory =
  /** УПД СЧФДОП/ДОП — кандидат, решает содержимое. */
  | 'utd_candidate'
  /** УПД с функцией СЧФ: только счёт-фактура, передачи товара нет. */
  | 'utd_invoice_only'
  | 'invoice'
  | 'revision'
  | 'correction'
  | 'waybill'
  | 'not_delivery'
  /** Скан или файл без типа: пока не берём, позже — распознаванием. */
  | 'scan'
  /** Тестовый, аннулированный, удалённый, исходящий, зашифрованный. */
  | 'excluded';

export const META_CATEGORY_LABELS: Record<EdoMetaCategory, string> = {
  utd_candidate: 'УПД — проверить позиции',
  utd_invoice_only: 'УПД-счёт-фактура — не берём',
  invoice: 'счёт-фактура — не берём',
  revision: 'исправление УПД — отдельная задача',
  correction: 'корректировка — отдельная задача',
  waybill: 'накладная, не УПД — не берём',
  not_delivery: 'не поставка — не берём',
  scan: 'скан без типа — пока не берём',
  excluded: 'исключён',
};

export type EdoMetaInput = {
  typeNamedId: string | null;
  documentFunction: string | null;
  isTest: boolean;
  revoked: boolean;
  isDeleted: boolean;
  outbound: boolean;
  encrypted: boolean;
};

export type EdoMetaDecision = { category: EdoMetaCategory; reason: string };

/** Уровень 1: решение по метаданным, без скачивания. */
export function classifyDocumentMeta(input: EdoMetaInput): EdoMetaDecision {
  // Сначала то, что исключает документ при любом типе.
  if (input.isTest) return { category: 'excluded', reason: 'тестовый документ' };
  if (input.revoked) return { category: 'excluded', reason: 'документ аннулирован' };
  if (input.isDeleted) return { category: 'excluded', reason: 'документ удалён' };
  if (input.outbound) return { category: 'excluded', reason: 'исходящий документ' };
  if (input.encrypted) return { category: 'excluded', reason: 'содержимое зашифровано' };

  const type = input.typeNamedId;
  const fn = input.documentFunction;

  if (!type) return { category: 'scan', reason: 'вложение без типа документа' };
  if (type === NONFORMALIZED) return { category: 'scan', reason: 'неформализованный документ (скан или файл)' };

  if (type === UTD) {
    if (fn && MATERIAL_FUNCTIONS.has(fn)) {
      return { category: 'utd_candidate', reason: `УПД ${fn}: передача товаров, работ или услуг` };
    }
    if (fn === 'СЧФ') {
      return { category: 'utd_invoice_only', reason: 'УПД с функцией СЧФ: только счёт-фактура' };
    }
    // Функция не сообщена: решит содержимое — она есть в самом XML.
    if (!fn) return { category: 'utd_candidate', reason: 'УПД без функции в метаданных: проверить по XML' };
    return { category: 'not_delivery', reason: `УПД с функцией ${fn}` };
  }
  if (INVOICE_TYPES.has(type)) return { category: 'invoice', reason: `счёт-фактура (${type})` };
  if (REVISION_TYPES.has(type)) return { category: 'revision', reason: 'исправление УПД' };
  if (CORRECTION_TYPES.has(type)) return { category: 'correction', reason: `корректировочный документ (${type})` };
  if (WAYBILL_TYPES.has(type)) return { category: 'waybill', reason: `товарная накладная (${type})` };
  return { category: 'not_delivery', reason: `не поставка (${type})` };
}

export type EdoContentCategory = 'materials' | 'services' | 'undetermined' | 'invoice_only';

export const CONTENT_CATEGORY_LABELS: Record<EdoContentCategory, string> = {
  materials: 'материалы',
  services: 'работы или услуги',
  undetermined: 'не определено',
  invoice_only: 'только счёт-фактура',
};

export type EdoContentDecision = {
  category: EdoContentCategory;
  reason: string;
  /** Сколько позиций какого предмета: 1 — имущество … 5 — иное, 0 — не заполнен. */
  kinds: Record<'goods' | 'work' | 'service' | 'rights' | 'other' | 'unknown', number>;
};

const KIND_KEYS: Record<UpdItemKind, keyof EdoContentDecision['kinds']> = {
  1: 'goods',
  2: 'work',
  3: 'service',
  4: 'rights',
  5: 'other',
};

/** Единицы, в которых отгружают материалы: масса, объём, длина, площадь. */
const GOODS_UNITS = /^(т|тн|тонн[аы]?|кг|г|м3|м³|куб\.?\s*м|м|пог\.?\s*м|м2|м²|кв\.?\s*м|л|рул|упак|уп|меш|под|пач|компл)\.?$/i;
/** Единицы работ и услуг. */
const SERVICE_UNITS = /^(усл\.?\s*ед\.?|усл\.?|услуга|ч|час|маш\.?-?ч(ас)?|мес|смена|сут|рейс|работа)\.?$/i;

/**
 * Уровень 2: решение по содержимому УПД.
 *
 * Косвенные признаки нужны там, где продавец не заполнил `ПрТовРаб`: он в
 * формате необязателен. Их три — содержание операции, грузоотправитель и
 * грузополучатель (у услуг их нет), единицы измерения.
 */
export function classifyUtdContent(parsed: UpdParsed): EdoContentDecision {
  const kinds: EdoContentDecision['kinds'] = {
    goods: 0,
    work: 0,
    service: 0,
    rights: 0,
    other: 0,
    unknown: 0,
  };
  for (const item of parsed.items) {
    kinds[item.kind ? KIND_KEYS[item.kind as UpdItemKind] : 'unknown'] += 1;
  }
  const total = parsed.items.length;
  const nonGoods = kinds.work + kinds.service + kinds.rights + kinds.other;

  if (parsed.function === 'СЧФ') {
    return { category: 'invoice_only', reason: 'в XML функция СЧФ: передачи товара нет', kinds };
  }
  if (kinds.goods > 0) {
    const rest = nonGoods > 0 ? `; работы и услуги — ${nonGoods}, берутся строками документа` : '';
    return {
      category: 'materials',
      reason: `имущество (ПрТовРаб=1) — ${kinds.goods} из ${total} позиций${rest}`,
      kinds,
    };
  }
  if (total > 0 && kinds.unknown === 0) {
    return {
      category: 'services',
      reason: `все ${total} позиций — работы, услуги или права (ПрТовРаб 2–5)`,
      kinds,
    };
  }

  // Признак не заполнен хотя бы у части позиций — смотрим косвенные.
  const goodsSignals: string[] = [];
  const serviceSignals: string[] = [];
  if (nonGoods > 0) serviceSignals.push(`${nonGoods} позиций с ПрТовРаб 2–5`);

  const operation = parsed.transfer?.operation ?? '';
  if (/товар/i.test(operation)) goodsSignals.push(`операция «${operation}»`);
  if (/работ|услуг/i.test(operation) && !/товар/i.test(operation)) {
    serviceSignals.push(`операция «${operation}»`);
  }
  if (parsed.consignee || parsed.consignor || parsed.consignorSameAsSeller) {
    goodsSignals.push('указан грузоотправитель или грузополучатель');
  }
  const units = parsed.items.map((i) => i.unit.trim());
  const goodsUnits = units.filter((u) => GOODS_UNITS.test(u));
  const serviceUnits = units.filter((u) => SERVICE_UNITS.test(u));
  if (goodsUnits.length > 0) goodsSignals.push(`единицы ${[...new Set(goodsUnits)].join(', ')}`);
  if (serviceUnits.length > 0 && goodsUnits.length === 0) {
    serviceSignals.push(`единицы ${[...new Set(serviceUnits)].join(', ')}`);
  }

  if (goodsSignals.length > 0 && serviceSignals.length === 0) {
    return {
      category: 'materials',
      reason: `ПрТовРаб не заполнен; по косвенным признакам — товар: ${goodsSignals.join('; ')}`,
      kinds,
    };
  }
  if (serviceSignals.length > 0 && goodsSignals.length === 0) {
    return {
      category: 'services',
      reason: `ПрТовРаб не заполнен; по косвенным признакам — работы или услуги: ${serviceSignals.join('; ')}`,
      kinds,
    };
  }
  return {
    category: 'undetermined',
    reason:
      goodsSignals.length === 0
        ? 'ПрТовРаб не заполнен, косвенных признаков нет'
        : `признаки противоречат: товар — ${goodsSignals.join('; ')}; услуги — ${serviceSignals.join('; ')}`,
    kinds,
  };
}
