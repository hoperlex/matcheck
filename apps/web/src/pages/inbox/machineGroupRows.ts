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
import type { SourceDocumentListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { documentGroupKey } from '../../shared/ui/documentGroupRows';
import {
  buildKeyedGroupRows,
  type GroupGutter,
  type KeyedGroupHead,
} from '../../shared/ui/groupRows';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';
import { isPendingRow } from './pendingRow';

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

/** «УПД УТ-134, УТ-135 · Накладная 85/11» — номера документов поставки на странице. */
export function machineNumbersLine(members: readonly Row[]): string {
  const byKind = new Map<string, string[]>();
  for (const r of members) {
    if (isPendingRow(r)) continue;
    const label = sourceKindLabel(r.kind);
    const list = byKind.get(label) ?? [];
    list.push(r.docNumber ?? 'без номера');
    byKind.set(label, list);
  }
  return [...byKind.entries()]
    .map(([label, numbers]) => `${label} ${numbers.join(', ')}`)
    .join(' · ');
}

/** Части строки группы: сколько документов, откуда, принята ли, что найдено. */
export function machineHeadParts(head: MachineHeadRow): {
  title: string;
  numbers: string;
  origin: string;
  merged: boolean;
  accepted: string | null;
  found: string | null;
} {
  const docs = head.group.members.filter((r) => !isPendingRow(r));
  const total = head.group.machine?.documentCount ?? docs.length;
  const uploads = head.group.machine?.uploadCount ?? 1;
  const deliveries = head.group.machine?.deliveryNumbers ?? [];
  return {
    title: `Поставка · ${documentsCount(total)}`,
    numbers: machineNumbersLine(head.group.members),
    origin:
      uploads > 1
        ? `объединена из ${uploads} ${plural(uploads, 'отправки', 'отправок', 'отправок')}`
        : 'одной отправкой',
    merged: uploads > 1,
    accepted: deliveries.length
      ? `Принята: ${deliveries.length > 1 ? 'приёмки' : 'приёмка'} ${deliveries.join(', ')}`
      : null,
    // Страницы поставку не разрывают (group-paging.ts) — меньше строк, чем в
    // машине, бывает только из-за фильтра.
    found: docs.length < total ? `найдено ${docs.length} из ${total}` : null,
  };
}
