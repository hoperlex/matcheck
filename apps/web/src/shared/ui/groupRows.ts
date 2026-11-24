/**
 * Строки таблицы с группами «как группировка строк в Excel»: строка группы над
 * её членами и скобка слева. Общее ядро для групп приёмок в «Принятых» и
 * поставок в «Документах» — ключ группы задаёт страница.
 *
 * Сервер уже ставит членов группы подряд; здесь — только представление:
 * строка группы вставляется перед первым членом на странице, у свёрнутой
 * группы члены скрыты, каждой строке назначается кусок скобки.
 *
 * Строки групп — искусственные, и таблица обязана их пережить: у них свой `id`
 * (rowKey), колонки их не рисуют (`withGroupRows`), выбрать их нельзя.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { TableProps } from 'antd';

type Column<T> = NonNullable<TableProps<T>['columns']>[number];

/** Кусок скобки слева от строки: кнопка, линия, уголок у последней. */
export type GroupGutter = 'head' | 'mid' | 'end' | null;

/** Строка группы над её членами. */
export type KeyedGroupHead<G> = {
  kind: 'group';
  /** `group:<key>` — таблица работает по rowKey="id". */
  id: string;
  key: string;
  group: G;
  /** Члены группы, попавшие на эту страницу (после фильтров), по порядку. */
  visibleIds: string[];
  collapsed: boolean;
};

export function isGroupHead(row: object): row is KeyedGroupHead<unknown> {
  return (row as { kind?: unknown }).kind === 'group';
}

export const groupHeadId = (key: string) => `group:${key}`;

/**
 * Строки таблицы с группами. `groupOf` вернул null — строка вне групп.
 * `minMembers` — с какого числа членов на странице рисовать группу (у поставки
 * из одного документа скобки нет). Новый массив — вход из кэша не мутируется.
 */
export function buildKeyedGroupRows<T extends { id: string }, G>(
  items: readonly T[],
  groupOf: (row: T) => { key: string; group: G } | null,
  collapsed: ReadonlySet<string>,
  opts: { minMembers?: number } = {},
): { rows: Array<T | KeyedGroupHead<G>>; gutter: ReadonlyMap<string, GroupGutter> } {
  const minMembers = opts.minMembers ?? 1;
  const clusters = new Map<string, { group: G; members: T[] }>();
  const order: Array<{ key: string | null; row: T }> = [];
  for (const row of items) {
    const g = groupOf(row);
    if (!g) {
      order.push({ key: null, row });
      continue;
    }
    const cluster = clusters.get(g.key);
    if (cluster) {
      cluster.members.push(row);
      continue;
    }
    clusters.set(g.key, { group: g.group, members: [row] });
    order.push({ key: g.key, row });
  }

  const rows: Array<T | KeyedGroupHead<G>> = [];
  const gutter = new Map<string, GroupGutter>();
  for (const entry of order) {
    if (!entry.key) {
      rows.push(entry.row);
      continue;
    }
    const cluster = clusters.get(entry.key)!;
    if (cluster.members.length < minMembers) {
      rows.push(...cluster.members);
      continue;
    }
    const isCollapsed = collapsed.has(entry.key);
    const head: KeyedGroupHead<G> = {
      kind: 'group',
      id: groupHeadId(entry.key),
      key: entry.key,
      group: cluster.group,
      visibleIds: cluster.members.map((m) => m.id),
      collapsed: isCollapsed,
    };
    rows.push(head);
    gutter.set(head.id, 'head');
    if (isCollapsed) continue;
    cluster.members.forEach((member, index) => {
      rows.push(member);
      gutter.set(member.id, index === cluster.members.length - 1 ? 'end' : 'mid');
    });
  }
  return { rows, gutter };
}

/**
 * Колонки страницы, пережившие строки групп. rc-table 7.54 зовёт `render`
 * ячейки ДО проверки `colSpan === 0` (rc-table/es/Cell), поэтому обернуть надо
 * сам `render`: колонка, читающая `r.status.code`, упала бы на строке группы.
 *
 * У строки группы первая колонка растянута на всю ширину (плюс ячейка выбора,
 * её закрывает `rowSelection.onCell`), остальные — `colSpan: 0`.
 */
export function withGroupRows<T extends object, H extends object = KeyedGroupHead<unknown>>(
  columns: readonly Column<T>[],
  renderHead: (head: H) => ReactNode,
  opts: { selectionCell: boolean },
): Column<T | H>[] {
  const span = columns.length + (opts.selectionCell ? 1 : 0);
  return columns.map((col, index) => {
    // Собственные render/onCell колонки — как есть: обёртка лишь не пускает
    // в них строку группы.
    const original = col as {
      render?: (value: unknown, record: T, i: number) => unknown;
      onCell?: (record: T, i?: number) => object;
    };
    const render = (value: unknown, record: T | H, i: number): ReactNode => {
      if (isGroupHead(record)) return index === 0 ? renderHead(record as H) : null;
      return original.render
        ? (original.render(value, record as T, i) as ReactNode)
        : (value as ReactNode);
    };
    const onCell = (record: T | H, i?: number) => {
      if (isGroupHead(record)) return { colSpan: index === 0 ? span : 0 };
      return original.onCell ? original.onCell(record as T, i) : {};
    };
    return { ...col, render, onCell } as unknown as Column<T | H>;
  });
}

/** Класс ячеек строки группы в режиме «по колонкам»: им разрешён перенос. */
export const GROUP_CELL_CLASS = 'mc-group-cell';

export type GroupHeadCellContext<T> = {
  /** `key` колонки (или её dataIndex), по нему строка группы выбирает содержимое. */
  key: string;
  /**
   * Нарисовать ячейку этой колонки так, как у строки `row`. Общее значение
   * группы (объект, сторона) выглядит тогда так же, как в строках под ней.
   */
  renderAs: (row: T) => ReactNode;
};

/**
 * Колонки страницы со строкой группы, разложенной ПО КОЛОНКАМ: каждая колонка
 * рисует свою ячейку строки группы (`headCell`), ничего не растягивается.
 * Нужна, когда у группы есть что показать в колонках — у поставки в
 * «Документах» это даты, объект, стороны, итог. Группы приёмок в «Принятых»
 * остаются на `withGroupRows`.
 *
 * Как и там, `render` и `onCell` колонки строку группы не получают: rc-table
 * зовёт `render` до проверки colSpan, и колонка, читающая `r.status.code`,
 * упала бы на ней. Ячейкам строки группы — класс GROUP_CELL_CLASS: общий стиль
 * таблицы режет ячейку в одну строку с «…», а в строке группы бывают
 * многострочные ячейки с кнопками (см. GroupBracketStyle).
 */
export function withGroupRowCells<T extends object, H extends object = KeyedGroupHead<unknown>>(
  columns: readonly Column<T>[],
  headCell: (head: H, ctx: GroupHeadCellContext<T>) => ReactNode,
): Column<T | H>[] {
  return columns.map((col, index) => {
    const original = col as {
      key?: unknown;
      dataIndex?: unknown;
      render?: (value: unknown, record: T, i: number) => unknown;
      onCell?: (record: T, i?: number) => object;
    };
    const dataIndex = typeof original.dataIndex === 'string' ? original.dataIndex : null;
    const key = String(original.key ?? dataIndex ?? index);
    const renderRow = (record: T, i: number, value?: unknown): ReactNode => {
      const v =
        value !== undefined || !dataIndex ? value : (record as Record<string, unknown>)[dataIndex];
      return original.render ? (original.render(v, record, i) as ReactNode) : (v as ReactNode);
    };
    const render = (value: unknown, record: T | H, i: number): ReactNode =>
      isGroupHead(record)
        ? headCell(record as H, { key, renderAs: (row: T) => renderRow(row, i) })
        : renderRow(record as T, i, value);
    const onCell = (record: T | H, i?: number) => {
      if (isGroupHead(record)) return { className: GROUP_CELL_CLASS };
      return original.onCell ? original.onCell(record as T, i) : {};
    };
    return { ...col, render, onCell } as unknown as Column<T | H>;
  });
}

const COLLAPSED_MAX = 300;

function readCollapsed(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Свёрнутые группы — удобство этого браузера, не общее состояние: хранилище
 * может быть пустым или недоступным (приватное окно), тогда всё развёрнуто.
 * Помним последние 300, чтобы список не рос бесконечно.
 */
export function useCollapsedGroups(storageKey: string): {
  collapsed: ReadonlySet<string>;
  toggle: (key: string) => void;
} {
  const [ids, setIds] = useState<string[]>(() => readCollapsed(storageKey));
  const collapsed = useMemo(() => new Set(ids), [ids]);
  const toggle = useCallback(
    (key: string) => {
      setIds((prev) => {
        const next = prev.includes(key)
          ? prev.filter((id) => id !== key)
          : [...prev, key].slice(-COLLAPSED_MAX);
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Без хранилища свёрнутость живёт до перезагрузки — это не ошибка.
        }
        return next;
      });
    },
    [storageKey],
  );
  return { collapsed, toggle };
}
