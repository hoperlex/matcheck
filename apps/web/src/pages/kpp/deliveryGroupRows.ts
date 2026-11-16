/**
 * Группы приёмок в таблице «Принятые»: строка группы над её приёмками и скобка
 * слева, как группировка строк в Excel.
 *
 * Сервер уже ставит приёмки группы подряд (`grouped=1`), здесь — только
 * представление: строки группы вставляются в данные таблицы, у свёрнутой
 * группы приёмки скрываются, каждой строке назначается кусок скобки.
 *
 * Строки группы — искусственные, и таблица обязана их пережить: у них свой
 * `id` (rowKey), колонки их не рисуют (`withGroupRows`), выбрать их нельзя.
 */
import type { ReactNode } from 'react';
import type { TableProps } from 'antd';
import { DELIVERY_GROUP_MAX, type Delivery, type DeliveryGroupSummary } from '@matcheck/contracts';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

/** Кусок скобки слева от строки: кнопка, линия, уголок у последней. */
export type GroupGutter = 'head' | 'mid' | 'end' | null;

/** Строка группы над её приёмками. */
export type GroupHeadRow = {
  kind: 'group';
  /** `group:<uuid>` — таблица работает по rowKey="id". */
  id: string;
  group: DeliveryGroupSummary;
  /** Приёмки группы, попавшие на эту страницу (после фильтров), по порядку. */
  visibleIds: string[];
  collapsed: boolean;
};

type Groupable = { id: string; deliveryGroup?: DeliveryGroupSummary | null };

export function isGroupHead(row: object): row is GroupHeadRow {
  return (row as { kind?: unknown }).kind === 'group';
}

export const groupHeadId = (groupId: string) => `group:${groupId}`;

/**
 * Строки таблицы с группами: строка группы — перед первой её приёмкой на
 * странице, приёмки группы стянуты к ней (страховка: сервер уже поставил их
 * подряд), у свёрнутой группы приёмки скрыты. Новый массив — вход из кэша
 * React Query не мутируется.
 */
export function buildGroupedRows<T extends Groupable>(
  items: readonly T[],
  collapsed: ReadonlySet<string>,
): { rows: Array<T | GroupHeadRow>; gutter: ReadonlyMap<string, GroupGutter> } {
  const clusters = new Map<string, T[]>();
  const order: Array<{ groupId: string | null; row: T }> = [];
  for (const row of items) {
    const groupId = row.deliveryGroup?.id ?? null;
    if (!groupId) {
      order.push({ groupId: null, row });
      continue;
    }
    const cluster = clusters.get(groupId);
    if (cluster) {
      cluster.push(row);
      continue;
    }
    clusters.set(groupId, [row]);
    order.push({ groupId, row });
  }

  const rows: Array<T | GroupHeadRow> = [];
  const gutter = new Map<string, GroupGutter>();
  for (const entry of order) {
    if (!entry.groupId) {
      rows.push(entry.row);
      continue;
    }
    const members = clusters.get(entry.groupId)!;
    const isCollapsed = collapsed.has(entry.groupId);
    const head: GroupHeadRow = {
      kind: 'group',
      id: groupHeadId(entry.groupId),
      group: entry.row.deliveryGroup!,
      visibleIds: members.map((m) => m.id),
      collapsed: isCollapsed,
    };
    rows.push(head);
    gutter.set(head.id, 'head');
    if (isCollapsed) continue;
    members.forEach((member, index) => {
      rows.push(member);
      gutter.set(member.id, index === members.length - 1 ? 'end' : 'mid');
    });
  }
  return { rows, gutter };
}

type GroupRowFields = Pick<
  Delivery,
  'id' | 'siteId' | 'pendingDeletionAt' | 'sourceShipmentId' | 'status' | 'deliveryGroup'
>;

/** Что сделает «Объединить в группу» с отмеченными: новая группа или пополнение. */
export type GroupJoinPlan =
  | { block: string }
  | { block: null; siteId: string; groupId: string | null };

/**
 * Можно ли объединить отмеченные приёмки — зеркало серверных проверок, чтобы
 * кнопка не обещала невозможного. Одна приёмка — можно: остальных добавят
 * поиском в окне «Группа приёмок».
 */
export function groupJoinPlan(rows: readonly GroupRowFields[]): GroupJoinPlan {
  if (rows.length === 0) return { block: 'Отметьте приёмки' };
  if (rows.length > DELIVERY_GROUP_MAX)
    return { block: `В группе не больше ${DELIVERY_GROUP_MAX} приёмок` };
  if (new Set(rows.map((r) => r.siteId)).size > 1)
    return { block: 'Выбраны приёмки разных объектов: в группе только приёмки одного объекта' };
  if (rows.some((r) => r.pendingDeletionAt))
    return { block: 'Среди отмеченных есть помеченные на удаление' };
  if (rows.some((r) => r.sourceShipmentId))
    return { block: 'Среди отмеченных есть приёмки, созданные из отгрузки' };
  if (rows.some((r) => r.status.code === 'draft'))
    return { block: 'Среди отмеченных есть черновики' };
  const groups = new Set(rows.map((r) => r.deliveryGroup?.id).filter((id): id is string => !!id));
  if (groups.size > 1)
    return { block: 'Отмеченные приёмки — из разных групп: сначала уберите лишние из групп' };
  const [groupId = null] = [...groups];
  if (groupId && rows.every((r) => r.deliveryGroup?.id === groupId))
    return { block: 'Отмеченные приёмки уже в одной группе — состав меняется в строке группы' };
  return { block: null, siteId: rows[0]!.siteId, groupId };
}

/** Почему «Убрать из группы» недоступно; null — можно. */
export function groupLeaveBlock(
  rows: readonly Pick<GroupRowFields, 'deliveryGroup'>[],
): string | null {
  if (rows.length === 0) return 'Отметьте приёмки';
  if (!rows.some((r) => r.deliveryGroup)) return 'Среди отмеченных нет приёмок в группе';
  return null;
}

/**
 * Колонки страницы, пережившие строки групп. rc-table 7.54 зовёт `render`
 * ячейки ДО проверки `colSpan === 0` (rc-table/es/Cell), поэтому обернуть надо
 * сам `render`: колонка, читающая `r.status.code`, упала бы на строке группы.
 *
 * У строки группы первая колонка растянута на всю ширину (плюс ячейка выбора,
 * её закрывает `rowSelection.onCell`), остальные — `colSpan: 0`.
 */
export function withGroupRows<T extends object>(
  columns: readonly Column<T>[],
  renderHead: (head: GroupHeadRow) => ReactNode,
  opts: { selectionCell: boolean },
): Column<T | GroupHeadRow>[] {
  const span = columns.length + (opts.selectionCell ? 1 : 0);
  return columns.map((col, index) => {
    // Собственные render/onCell колонки — как есть: обёртка лишь не пускает
    // в них строку группы.
    const original = col as {
      render?: (value: unknown, record: T, i: number) => unknown;
      onCell?: (record: T, i?: number) => object;
    };
    const render = (value: unknown, record: T | GroupHeadRow, i: number): ReactNode => {
      if (isGroupHead(record)) return index === 0 ? renderHead(record) : null;
      return original.render
        ? (original.render(value, record, i) as ReactNode)
        : (value as ReactNode);
    };
    const onCell = (record: T | GroupHeadRow, i?: number) => {
      if (isGroupHead(record)) return { colSpan: index === 0 ? span : 0 };
      return original.onCell ? original.onCell(record, i) : {};
    };
    return { ...col, render, onCell } as unknown as Column<T | GroupHeadRow>;
  });
}

/** «3 приёмки», «1 приёмка», «5 приёмок». */
export function deliveriesCount(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  const word =
    last === 1 && lastTwo !== 11
      ? 'приёмка'
      : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
        ? 'приёмки'
        : 'приёмок';
  return `${n} ${word}`;
}
