/**
 * Хеш содержимого приёмки для 1С.
 *
 * Хешируется не весь ответ, а ЯДРО — явный список полей, по которым 1С
 * сопоставляет и проводит документ. Почему не весь ответ:
 *  - переименование объекта или контрагента в справочнике не должно заново
 *    рассылать все выгруженные приёмки окна;
 *  - новое справочное поле в ответе не должно менять хеш всей истории.
 *
 * Почему список, а не «всё, кроме»: и у списка есть риск — забыть поле. От него
 * страхует тест классификации (test/onec-content-hash.test.ts): каждое поле
 * ответа обязано стоять ровно в одном из двух списков — CORE_PATHS или
 * EXCLUDED_PATHS с причиной. Новое поле без решения роняет тест.
 *
 * Массивы в ядре сортируются по канонической строке элемента — это полный
 * порядок: перестановка строк (в т.ч. с равными номерами и разным НДС) хеш не
 * меняет, а любое изменение значения — меняет. Id строк приёмки в ядро не
 * входят: они пересоздаются при каждом сохранении.
 *
 * Ядро меняется только новой версией (HASH_VERSION) с сохранением старой
 * функции: подтверждение 1С несёт версию, сравнение идёт в версии сохранённого
 * хеша.
 */
import { createHash } from 'node:crypto';
import type { OnecDeliveryBody } from './export-payload.js';

export const HASH_VERSION = 1;
export const SUPPORTED_HASH_VERSIONS: readonly number[] = [1];

/** Поля, по которым 1С сопоставляет и проводит документ. */
export const CORE_PATHS: readonly string[] = [
  'id',
  'displayId',
  'status',
  'confirmedAt',
  'arrivedAt',
  'operation',
  'sourceShipmentDisplayId',
  'site.code',
  'site.fotSiteId',
  'purpose',
  'supplier.inn',
  'supplier.kpp',
  'recipient.kind',
  'recipient.inn',
  'recipient.kpp',
  'recipient.molId',
  'contract.onecId',
  'contract.counterpartyOnecId',
  'contract.number',
  'contract.date',
  'edo[].exportDocumentId',
  'edo[].sourceDocumentId',
  'edo[].sha256',
  'groups[].groupKey',
  'groups[].document.id',
  'groups[].document.kind',
  'groups[].document.number',
  'groups[].document.date',
  'groups[].document.linked',
  'groups[].document.dedupKey.supplierInn',
  'groups[].document.dedupKey.number',
  'groups[].document.dedupKey.date',
  'groups[].document.supplier.inn',
  'groups[].document.supplier.kpp',
  'groups[].document.buyer.inn',
  'groups[].document.buyer.kpp',
  'groups[].document.consignee.inn',
  'groups[].document.consignee.kpp',
  'groups[].document.recipient.kind',
  'groups[].document.recipient.inn',
  'groups[].document.recipient.kpp',
  'groups[].document.recipient.molId',
  'groups[].document.purpose',
  'groups[].document.contract.onecId',
  'groups[].document.contract.counterpartyOnecId',
  'groups[].document.contract.number',
  'groups[].document.contract.date',
  'groups[].document.printedTotals.totalSum',
  'groups[].document.printedTotals.vatSum',
  'groups[].document.edo[].exportDocumentId',
  'groups[].document.edo[].sourceDocumentId',
  'groups[].document.edo[].sha256',
  'groups[].lines[].lineNo',
  'groups[].lines[].name',
  'groups[].lines[].material.id',
  'groups[].lines[].material.code',
  'groups[].lines[].unit',
  'groups[].lines[].qtyPlanned',
  'groups[].lines[].qtyActual',
  'groups[].lines[].price',
  'groups[].lines[].vatRate',
  'groups[].lines[].vatSum',
  'groups[].lines[].itemKind',
  'groups[].lines[].inventoryNumber',
  'groups[].lines[].serialNumber',
];

const NAME = 'название из справочника: переименование не должно заново рассылать выгруженное';
const DERIVED = 'производное от полей ядра';
const EDO_BY_ID = 'определяется строкой реестра ЭДО (id + sha256 уже в ядре)';
const NOT_CONTENT = 'не содержимое приёмки';

/** Поля ответа вне ядра — с причиной. */
export const EXCLUDED_PATHS: Readonly<Record<string, string>> = {
  snapshotAt: 'момент чтения, меняется при каждом запросе',
  'deletion.pendingSince': 'удаление ведёт очередь (причина deleted), а не хеш',
  'site.name': NAME,
  'supplier.name': NAME,
  'recipient.name': NAME,
  'contract.name': NAME,
  'edo[].matchId': 'id привязки меняется при перепривязке той же УПД',
  'edo[].operator': EDO_BY_ID,
  'edo[].number': EDO_BY_ID,
  'edo[].date': EDO_BY_ID,
  'edo[].correctionNumber': EDO_BY_ID,
  'edo[].supplierInn': EDO_BY_ID,
  'edo[].totalSum': EDO_BY_ID,
  'edo[].vatSum': EDO_BY_ID,
  'edo[].sizeBytes': EDO_BY_ID,
  'edo[].xmlAvailable': 'доступность файла, не содержимое',
  'edo[].xmlPath': 'адрес, не содержимое',
  'groups[].document.portalDuplicates': 'сведения о других карточках портала',
  'groups[].document.supplier.name': NAME,
  'groups[].document.recipient.name': NAME,
  'groups[].document.buyer.name': NAME,
  'groups[].document.consignee.name': NAME,
  'groups[].document.contract.name': NAME,
  'groups[].document.sharedWith': 'список других приёмок, не содержимое этой',
  'groups[].document.edo[].matchId': 'id привязки меняется при перепривязке той же УПД',
  'groups[].document.edo[].operator': EDO_BY_ID,
  'groups[].document.edo[].number': EDO_BY_ID,
  'groups[].document.edo[].date': EDO_BY_ID,
  'groups[].document.edo[].correctionNumber': EDO_BY_ID,
  'groups[].document.edo[].supplierInn': EDO_BY_ID,
  'groups[].document.edo[].totalSum': EDO_BY_ID,
  'groups[].document.edo[].vatSum': EDO_BY_ID,
  'groups[].document.edo[].sizeBytes': EDO_BY_ID,
  'groups[].document.edo[].xmlAvailable': 'доступность файла, не содержимое',
  'groups[].document.edo[].xmlPath': 'адрес, не содержимое',
  'groups[].lines[].material.name': NAME,
  'groups[].lines[].okei': 'код ОКЕИ из справочника единиц, производное от unit',
  'groups[].lines[].qty': DERIVED,
  'groups[].lines[].priceWithVat': DERIVED,
  'groups[].lines[].vatRateKind': DERIVED,
  'groups[].lines[].sumExVat': DERIVED,
  'groups[].lines[].sumWithVat': DERIVED,
  'groups[].lines[].warnings': DERIVED,
  'groups[].totals.linesTotal': DERIVED,
  'groups[].totals.linesWithSum': DERIVED,
  'groups[].totals.linesWithVat': DERIVED,
  'groups[].totals.linesComplete': DERIVED,
  'groups[].totals.sumExVat': DERIVED,
  'groups[].totals.vatSum': DERIVED,
  'groups[].totals.sumWithVat': DERIVED,
  'groups[].totals.complete': DERIVED,
  'totals.linesTotal': DERIVED,
  'totals.linesWithSum': DERIVED,
  'totals.linesWithVat': DERIVED,
  'totals.linesComplete': DERIVED,
  'totals.sumExVat': DERIVED,
  'totals.vatSum': DERIVED,
  'totals.sumWithVat': DERIVED,
  'totals.complete': DERIVED,
  contentHash: NOT_CONTENT,
  hashVersion: NOT_CONTENT,
  'export.state': NOT_CONTENT,
  'export.exportedAt': NOT_CONTENT,
  'export.exportedHash': NOT_CONTENT,
  'export.queueReason': NOT_CONTENT,
  'export.lastError': NOT_CONTENT,
  'export.lastErrorAt': NOT_CONTENT,
};

const CORE = new Set(CORE_PATHS);
/** Префиксы, у которых есть потомки в ядре — их объекты проецируются. */
const CORE_PREFIXES = new Set(
  CORE_PATHS.flatMap((p) => {
    const parts: string[] = [];
    let acc = '';
    for (const seg of p.split('.')) {
      acc = acc ? `${acc}.${seg}` : seg;
      parts.push(acc);
      if (acc.endsWith('[]')) parts.push(acc.slice(0, -2));
    }
    return parts;
  }),
);

/** JSON с отсортированными ключами — одна строка на одно значение. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function project(value: unknown, prefix: string): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) {
    const itemPrefix = `${prefix}[]`;
    return value
      .map((v) => project(v, itemPrefix))
      .map((v) => [canonicalJson(v), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (CORE.has(path)) out[k] = v ?? null;
    else if (CORE_PREFIXES.has(path)) out[k] = project(v, path);
  }
  return out;
}

/** Ядро ответа — то, что хешируется. Экспортировано для тестов. */
export function hashCore(body: OnecDeliveryBody): unknown {
  return project(body, '');
}

export function computeContentHash(body: OnecDeliveryBody): string {
  return createHash('sha256')
    .update(`matcheck-onec-v${HASH_VERSION}\n`)
    .update(canonicalJson(hashCore(body)))
    .digest('hex');
}
