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
import {
  buildKeyedGroupRows,
  groupHeadId as sharedGroupHeadId,
  isGroupHead as sharedIsGroupHead,
  withGroupRows as sharedWithGroupRows,
  type GroupGutter as SharedGroupGutter,
  type KeyedGroupHead,
} from '../../shared/ui/groupRows';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

/** Кусок скобки слева от строки: кнопка, линия, уголок у последней. */
export type GroupGutter = SharedGroupGutter;

/** Строка группы над её приёмками. Ядро — shared/ui/groupRows.ts. */
// `key` необязателен: «Принятые» ключ берут из group.id и строку группы
// могут собрать сами (тесты, карточка узкого экрана).
export type GroupHeadRow = Omit<KeyedGroupHead<DeliveryGroupSummary>, 'key'> & { key?: string };

type Groupable = { id: string; deliveryGroup?: DeliveryGroupSummary | null };

export function isGroupHead(row: object): row is GroupHeadRow {
  return sharedIsGroupHead(row);
}

export const groupHeadId = sharedGroupHeadId;

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
  return buildKeyedGroupRows<T, DeliveryGroupSummary>(
    items,
    (row) => (row.deliveryGroup ? { key: row.deliveryGroup.id, group: row.deliveryGroup } : null),
    collapsed,
  );
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

/** Колонки страницы, пережившие строки групп — см. shared/ui/groupRows.ts. */
export function withGroupRows<T extends object>(
  columns: readonly Column<T>[],
  renderHead: (head: GroupHeadRow) => ReactNode,
  opts: { selectionCell: boolean },
): Column<T | GroupHeadRow>[] {
  return sharedWithGroupRows<T, GroupHeadRow>(columns, renderHead, opts);
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
