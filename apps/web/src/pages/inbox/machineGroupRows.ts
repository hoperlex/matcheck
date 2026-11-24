/**
 * Поставки в «Документах» скобкой «−/+» — как группы приёмок в «Принятых».
 *
 * Группа — машина: документы одной отправки с /uploads, а после «Объединить в
 * одну машину» — нескольких. Ключ — `documentGroupKey` (голова машины), сервер
 * уже держит её документы подряд и на одной странице (group-paging.ts).
 *
 * Скобку получает поставка из двух и более строк: одиночный документ — обычная
 * строка, как приёмка вне группы.
 */
import { isPlaceholderInn, type SourceDocumentListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { documentGroupKey } from '../../shared/ui/documentGroupRows';
import {
  buildKeyedGroupRows,
  type GroupGutter,
  type KeyedGroupHead,
} from '../../shared/ui/groupRows';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';
import { isPendingRow } from './pendingRow';
import { isUnrecognized } from './unrecognizedRow';

type Row = z.infer<typeof SourceDocumentListResponseSchema>['items'][number];

export type MachineGroupInfo = {
  /** Сводка машины с сервера — по ВСЕЙ машине, не по странице. */
  machine: NonNullable<Row['machine']> | null;
  /** Строки машины на этой странице (документы и принятые файлы), по порядку. */
  members: Row[];
};

export type MachineHeadRow = KeyedGroupHead<MachineGroupInfo>;

export const MACHINE_GROUPS_COLLAPSED_KEY = 'matcheck.documentMachines.collapsed';

export function buildMachineRows(
  items: readonly Row[],
  collapsed: ReadonlySet<string>,
): { rows: Array<Row | MachineHeadRow>; gutter: ReadonlyMap<string, GroupGutter> } {
  const infos = new Map<string, MachineGroupInfo>();
  for (const row of items) {
    const key = documentGroupKey(row);
    if (!key) continue;
    const info = infos.get(key) ?? { machine: null, members: [] };
    info.members.push(row);
    if (!info.machine && row.machine) info.machine = row.machine;
    infos.set(key, info);
  }
  return buildKeyedGroupRows<Row, MachineGroupInfo>(
    items,
    (row) => {
      const key = documentGroupKey(row);
      return key ? { key, group: infos.get(key)! } : null;
    },
    collapsed,
    { minMembers: 2 },
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
};

export const documentsCount = (n: number) =>
  `${n} ${plural(n, 'документ', 'документа', 'документов')}`;

/**
 * Общее значение поставки для колонки строки поставки.
 *
 * Пустое значение (у накладной нет покупателя, у файла — даты) не
 * противоречит остальным: «—» значит «неизвестно», а не «другое». Поэтому
 * пустые не считаются: одно непустое на всех — `same` с документом-
 * представителем (ячейка рисуется так же, как у него), несколько — `mixed`,
 * ни одного — `empty`.
 */
export type HeadValue = { kind: 'same'; row: Row } | { kind: 'mixed' } | { kind: 'empty' };

/** Даты поставки: одна (`from === to`) или диапазон. */
export type HeadDateRange = { from: string; to: string };

/**
 * Итог одной суммы по УПД поставки. `counted` — у скольких УПД сумма
 * распознана, `of` — сколько УПД вошло в итог. Полнота у «Суммы» и «НДС» своя:
 * НДС бывает не распознан там, где сумма есть.
 */
export type HeadMoney = { amount: string; counted: number; of: number };

/** Что строка поставки показывает в колонках таблицы. */
export type MachineHeadSummary = {
  /** «3 документа» — по всей машине (сервер), не по странице. */
  title: string;
  /** Номера для колонки «№» — без видов («7499, 33»): колонка узкая. */
  numbers: string;
  /** Номера с видами — для подсказки и карточки: «УПД 7499 · Накладная 33». */
  numbersFull: string;
  /** «объединена из 2 отправок» — только у объединённой вручную машины. */
  origin: string | null;
  merged: boolean;
  /** «Принята: приёмки 27275, 27276 и ещё 3»; `full` — весь список. */
  accepted: { label: string; full: string } | null;
  /** «найдено 2 из 4» — фильтр оставил часть машины. */
  found: string | null;
  /**
   * Обобщения по машине — только для ПОЛНОЙ машины. Под фильтром на странице
   * лишь часть документов, и итог двух УПД из трёх читался бы как итог
   * поставки; тогда `null`, и ячейки пустые.
   */
  aggregates: {
    docDate: HeadDateRange | null;
    expectedDate: HeadDateRange | null;
    site: HeadValue;
    buyer: HeadValue;
    consignee: HeadValue;
    supplier: HeadValue;
    /** `null` — в поставке нет УПД с распознанной суммой. */
    vatSum: HeadMoney | null;
    totalSum: HeadMoney | null;
  } | null;
};

/** Сколько номеров приёмок показывать в строке; остальные — «и ещё N». */
const ACCEPTED_SHOWN = 2;

function headValue(rows: readonly Row[], key: (r: Row) => string | null): HeadValue {
  let found: { key: string; row: Row } | null = null;
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    if (!found) found = { key: k, row };
    else if (found.key !== k) return { kind: 'mixed' };
  }
  return found ? { kind: 'same', row: found.row } : { kind: 'empty' };
}

/**
 * Сторона сравнивается по ИНН: «ООО "СТРОИТЕЛЬНОЕ…"» и «ООО «Строительное…»»
 * с одним ИНН — одна организация. ИНН-заглушка (0000…) ничего не говорит —
 * тогда по названию без регистра.
 */
function partyKey(name: string | null | undefined, inn: string | null | undefined): string | null {
  const i = inn?.trim();
  if (i && !isPlaceholderInn(i)) return `inn:${i}`;
  const n = name?.trim().toLowerCase();
  return n ? `name:${n}` : null;
}

function dateRange(values: ReadonlyArray<string | null | undefined>): HeadDateRange | null {
  const days = values.filter((v): v is string => !!v).map((v) => v.slice(0, 10));
  if (days.length === 0) return null;
  days.sort();
  return { from: days[0]!, to: days[days.length - 1]! };
}

/** Деньги — в копейках: 0,1 + 0,2 в плавающей точке не равны 0,3. */
function toKopecks(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function fromKopecks(k: number): string {
  const sign = k < 0 ? '-' : '';
  const abs = Math.abs(k);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Итог по УПД. Ноль — это значение (НДС 0,00 ₽ у упрощенца), отсутствует только
 * `null`. Нет ни одной распознанной суммы — `null`, ячейка «—».
 */
function moneyTotal(
  upds: readonly Row[],
  pick: (r: Row) => string | null | undefined,
): HeadMoney | null {
  let sum = 0;
  let counted = 0;
  for (const row of upds) {
    const k = toKopecks(pick(row));
    if (k === null) continue;
    sum += k;
    counted += 1;
  }
  return counted === 0 ? null : { amount: fromKopecks(sum), counted, of: upds.length };
}

/**
 * Номера поставки: для колонки «№» — подряд без видов («УТ-134, УТ-135, 85/11»),
 * с видами — для подсказки и карточки («УПД УТ-134, УТ-135 · Накладная 85/11»).
 * В узкой колонке вид съедал место, и от номеров оставалось «УПД 7499 · …».
 */
function numbersOf(docs: readonly Row[]): { numbers: string; numbersFull: string } {
  const byKind = new Map<string, string[]>();
  for (const r of docs) {
    const label = sourceKindLabel(r.kind);
    const list = byKind.get(label) ?? [];
    list.push(r.docNumber ?? 'без номера');
    byKind.set(label, list);
  }
  const parts = [...byKind.entries()];
  return {
    numbersFull: parts.map(([label, numbers]) => `${label} ${numbers.join(', ')}`).join(' · '),
    numbers: parts.flatMap(([, numbers]) => numbers).join(', '),
  };
}

/**
 * Сводка строки поставки.
 *
 * Кто во что входит:
 * - документы — члены группы без принятых файлов (у файла документа ещё нет);
 * - основные — документы без сопроводительных и нераспознанных (`isUnrecognized`):
 *   у них нет ни вида, ни реквизитов, и шапка писала бы «УПД без номера»;
 * - объект и дата поставки — по всем документам: их ставит сама загрузка;
 * - номера, дата документа и стороны — по основным;
 * - суммы — по основным УПД, кроме архива и дубликатов (`duplicate_upd`):
 *   копия того же УПД задвоила бы итог; накладные не суммируем — они часто
 *   везут тот же груз, что и УПД.
 */
export function machineHeadSummary(head: MachineHeadRow): MachineHeadSummary {
  const docs = head.group.members.filter((r) => !isPendingRow(r));
  const main = docs.filter((r) => !isUnrecognized(r));
  // Нет сводки с сервера (старая сборка API) — считаем машину полной по
  // строкам страницы: страницы поставку не разрывают (group-paging.ts).
  const total = head.group.machine?.documentCount ?? docs.length;
  const complete = docs.length >= total;
  const uploads = head.group.machine?.uploadCount ?? 1;
  const deliveries = head.group.machine?.deliveryNumbers ?? [];

  const upds = main.filter(
    (r) => r.kind === 'upd' && r.status !== 'archived' && r.parseErrorCode !== 'duplicate_upd',
  );
  const shown = deliveries.slice(0, ACCEPTED_SHOWN);
  const rest = deliveries.length - shown.length;
  const noun = deliveries.length > 1 ? 'приёмки' : 'приёмка';

  return {
    title: documentsCount(total),
    ...numbersOf(main),
    origin:
      uploads > 1
        ? `объединена из ${uploads} ${plural(uploads, 'отправки', 'отправок', 'отправок')}`
        : null,
    merged: uploads > 1,
    accepted: deliveries.length
      ? {
          label: `Принята: ${noun} ${shown.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`,
          full: `Принята: ${noun} ${deliveries.join(', ')}`,
        }
      : null,
    found: complete ? null : `найдено ${docs.length} из ${total}`,
    aggregates: complete
      ? {
          docDate: dateRange(main.map((r) => r.docDate)),
          expectedDate: dateRange(docs.map((r) => r.expectedDate)),
          site: headValue(docs, (r) => r.siteId ?? null),
          buyer: headValue(main, (r) => partyKey(r.buyerName, r.buyerInn)),
          consignee: headValue(main, (r) => partyKey(r.consigneeName, r.consigneeInn)),
          supplier: headValue(main, (r) => partyKey(r.supplierName, r.supplierInn)),
          vatSum: moneyTotal(upds, (r) => r.vatSum),
          totalSum: moneyTotal(upds, (r) => r.totalSum),
        }
      : null,
  };
}
