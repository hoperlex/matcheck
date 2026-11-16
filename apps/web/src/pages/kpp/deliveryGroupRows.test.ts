/**
 * Строки групп в «Принятых»: где встаёт строка группы, какой кусок скобки у
 * каждой приёмки, что скрывает свёрнутая группа, и почему кнопки группы
 * выключены. Колонки обязаны пережить строку группы — rc-table зовёт render
 * ячейки до проверки colSpan.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryGroupSummary } from '@matcheck/contracts';
import {
  buildGroupedRows,
  deliveriesCount,
  groupJoinPlan,
  groupLeaveBlock,
  isGroupHead,
  withGroupRows,
  type GroupHeadRow,
} from './deliveryGroupRows';

const group = (id: string, ...members: string[]): DeliveryGroupSummary => ({
  id,
  siteId: 'site-1',
  members: members.map((deliveryId, i) => ({ deliveryId, displayId: 100 - i })),
});
const G = group('g-1', 'a', 'b', 'c');
const row = (id: string, deliveryGroup: DeliveryGroupSummary | null = null) => ({
  id,
  deliveryGroup,
});

describe('buildGroupedRows', () => {
  it('строка группы перед первой приёмкой, скобка head/mid/end, одиночные без скобки', () => {
    const items = [row('x'), row('a', G), row('b', G), row('c', G), row('y')];
    const { rows, gutter } = buildGroupedRows(items, new Set());
    expect(rows.map((r) => r.id)).toEqual(['x', 'group:g-1', 'a', 'b', 'c', 'y']);
    const head = rows[1] as GroupHeadRow;
    expect(isGroupHead(head)).toBe(true);
    expect(head).toMatchObject({ visibleIds: ['a', 'b', 'c'], collapsed: false });
    expect([...gutter.entries()]).toEqual([
      ['group:g-1', 'head'],
      ['a', 'mid'],
      ['b', 'mid'],
      ['c', 'end'],
    ]);
    expect(gutter.has('x')).toBe(false);
  });

  it('свёрнутая группа — одна строка группы; разорванная группа стягивается', () => {
    const items = [row('a', G), row('x'), row('c', G)];
    const open = buildGroupedRows(items, new Set());
    expect(open.rows.map((r) => r.id)).toEqual(['group:g-1', 'a', 'c', 'x']);
    const closed = buildGroupedRows(items, new Set(['g-1']));
    expect(closed.rows.map((r) => r.id)).toEqual(['group:g-1', 'x']);
    expect((closed.rows[0] as GroupHeadRow).collapsed).toBe(true);
    // Частичный показ: на странице две из трёх.
    expect((closed.rows[0] as GroupHeadRow).visibleIds).toEqual(['a', 'c']);
  });

  it('вход не мутируется', () => {
    const items = [row('a', G), row('x'), row('c', G)];
    const copy = [...items];
    buildGroupedRows(items, new Set());
    expect(items).toEqual(copy);
  });
});

describe('кнопки групп', () => {
  const status = (code: string) => ({
    id: `st-${code}`,
    entityType: 'delivery',
    code,
    label: code,
    color: null,
    sortOrder: 0,
  });
  const r = (
    over: Partial<Parameters<typeof groupJoinPlan>[0][number]> = {},
  ): Parameters<typeof groupJoinPlan>[0][number] => ({
    id: `d-${Math.random()}`,
    siteId: 's1',
    pendingDeletionAt: null,
    sourceShipmentId: null,
    status: status('filled'),
    deliveryGroup: null,
    ...over,
  });

  it('объединить: новая группа; пополнение одной группы; причины отказа', () => {
    expect(groupJoinPlan([r(), r()])).toEqual({ block: null, siteId: 's1', groupId: null });
    expect(groupJoinPlan([r()])).toEqual({ block: null, siteId: 's1', groupId: null });
    expect(groupJoinPlan([r({ deliveryGroup: G }), r()])).toEqual({
      block: null,
      siteId: 's1',
      groupId: 'g-1',
    });
    const reason = (rows: ReturnType<typeof r>[]) => {
      const plan = groupJoinPlan(rows);
      return plan.block;
    };
    expect(reason([])).toMatch(/Отметьте/);
    expect(reason([r(), r({ siteId: 's2' })])).toMatch(/разных объектов/);
    expect(reason([r({ pendingDeletionAt: '2026-11-16T10:00:00Z' })])).toMatch(/на удаление/);
    expect(reason([r({ sourceShipmentId: 'sh' })])).toMatch(/из отгрузки/);
    expect(reason([r({ status: status('draft') })])).toMatch(/черновики/);
    expect(reason([r({ deliveryGroup: G }), r({ deliveryGroup: group('g-2', 'z', 'w') })])).toMatch(
      /разных групп/,
    );
    expect(reason([r({ deliveryGroup: G }), r({ deliveryGroup: G })])).toMatch(
      /уже в одной группе/,
    );
    expect(reason(Array.from({ length: 51 }, () => r()))).toMatch(/не больше 50/);
  });

  it('убрать из группы — только если среди отмеченных есть приёмки в группе', () => {
    expect(groupLeaveBlock([])).toMatch(/Отметьте/);
    expect(groupLeaveBlock([{ deliveryGroup: null }])).toMatch(/нет приёмок в группе/);
    expect(groupLeaveBlock([{ deliveryGroup: null }, { deliveryGroup: G }])).toBeNull();
  });

  it('склонение', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map(deliveriesCount)).toEqual([
      '1 приёмка',
      '2 приёмки',
      '5 приёмок',
      '11 приёмок',
      '21 приёмка',
      '22 приёмки',
      '25 приёмок',
    ]);
  });
});

describe('withGroupRows', () => {
  type R = { id: string; status: { code: string } };
  const head: GroupHeadRow = {
    kind: 'group',
    id: 'group:g-1',
    group: G,
    visibleIds: ['a'],
    collapsed: false,
  };

  it('строка группы: render колонок не зовётся, первая растянута на всю ширину с выбором', () => {
    const statusRender = vi.fn((_: unknown, r: R) => r.status.code);
    const onCell = vi.fn(() => ({ className: 'x' }));
    const cols = withGroupRows<R>(
      [
        { key: 'id', dataIndex: 'id' },
        { key: 'status', render: statusRender, onCell },
        { key: 'sum' },
      ],
      () => 'ГРУППА',
      { selectionCell: true },
    ) as Array<{
      render: (v: unknown, r: R | GroupHeadRow, i: number) => unknown;
      onCell: (r: R | GroupHeadRow, i?: number) => object;
    }>;
    expect(cols[0]!.render(undefined, head, 0)).toBe('ГРУППА');
    expect(cols[1]!.render(undefined, head, 0)).toBeNull();
    expect(statusRender).not.toHaveBeenCalled();
    expect(cols[0]!.onCell(head)).toEqual({ colSpan: 4 });
    expect(cols[1]!.onCell(head)).toEqual({ colSpan: 0 });
    expect(onCell).not.toHaveBeenCalled();

    const plain: R = { id: 'a', status: { code: 'filled' } };
    expect(cols[1]!.render(undefined, plain, 0)).toBe('filled');
    expect(cols[0]!.render('a', plain, 0)).toBe('a');
    expect(cols[1]!.onCell(plain, 0)).toEqual({ className: 'x' });
  });

  it('без колонки выбора ширина — по числу колонок', () => {
    const cols = withGroupRows<R>([{ key: 'a' }, { key: 'b' }], () => null, {
      selectionCell: false,
    }) as Array<{ onCell: (r: R | GroupHeadRow) => object }>;
    expect(cols[0]!.onCell(head)).toEqual({ colSpan: 2 });
  });
});
