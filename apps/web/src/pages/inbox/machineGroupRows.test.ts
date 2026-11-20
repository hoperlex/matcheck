import { describe, expect, it } from 'vitest';
import { buildMachineRows, machineHeadParts, type MachineHeadRow } from './machineGroupRows';

type Row = Parameters<typeof buildMachineRows>[0][number];

const doc = (id: string, over: Partial<Row> = {}): Row =>
  ({
    id,
    kind: 'upd',
    docNumber: `N-${id}`,
    portalGroupId: null,
    groupId: null,
    machine: null,
    siteName: 'ЖК ДОМ 56',
    expectedDate: '2026-11-19',
    ...over,
  }) as unknown as Row;

const machine = (
  id: string,
  documentCount: number,
  uploadCount = 1,
  deliveryNumbers: number[] = [],
) => ({
  id,
  documentCount,
  uploadCount,
  deliveryNumbers,
});

describe('поставки скобкой в «Документах»', () => {
  it('поставка из двух документов — строка поставки и скобка; одиночный — без скобки', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000001';
    const items = [
      doc('a', { portalGroupId: m, machine: machine(m, 2) }),
      doc('b', { portalGroupId: m, machine: machine(m, 2), kind: 'transport_waybill' }),
      doc('c', { portalGroupId: 'bbbbbbbb-0000-0000-0000-000000000002' }),
    ];
    const { rows, gutter } = buildMachineRows(items, new Set());
    expect(rows.map((r) => r.id)).toEqual([`group:${m}`, 'a', 'b', 'c']);
    expect(gutter.get(`group:${m}`)).toBe('head');
    expect(gutter.get('a')).toBe('mid');
    expect(gutter.get('b')).toBe('end');
    expect(gutter.get('c')).toBeUndefined();
  });

  it('свёрнутая поставка прячет документы, строка поставки остаётся', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000003';
    const items = [doc('a', { portalGroupId: m }), doc('b', { portalGroupId: m })];
    const { rows } = buildMachineRows(items, new Set([m]));
    expect(rows.map((r) => r.id)).toEqual([`group:${m}`]);
  });

  it('строка поставки: номера по видам, одна отправка, принята', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000004';
    const items = [
      doc('a', { portalGroupId: m, docNumber: 'УТ-134', machine: machine(m, 3, 1, [25840]) }),
      doc('b', { portalGroupId: m, docNumber: 'УТ-135' }),
      doc('c', { portalGroupId: m, docNumber: '85/11', kind: 'transport_waybill' }),
    ];
    const head = buildMachineRows(items, new Set()).rows[0] as MachineHeadRow;
    const parts = machineHeadParts(head);
    expect(parts.title).toBe('3 документа');
    expect(parts.numbers).toBe('УПД УТ-134, УТ-135 · Накладная 85/11');
    expect(parts.origin).toBe('одной отправкой');
    expect(parts.merged).toBe(false);
    expect(parts.accepted).toBe('Принята: приёмка 25840');
    expect(parts.found).toBeNull();
  });

  it('объединённая машина и фильтр: «объединена из 2 отправок», «найдено 2 из 4»', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000005';
    const items = [
      doc('a', { portalGroupId: m, machine: machine(m, 4, 2) }),
      doc('b', { portalGroupId: m, machine: machine(m, 4, 2) }),
    ];
    const parts = machineHeadParts(buildMachineRows(items, new Set()).rows[0] as MachineHeadRow);
    expect(parts.origin).toBe('объединена из 2 отправок');
    expect(parts.merged).toBe(true);
    expect(parts.found).toBe('найдено 2 из 4');
  });

  it('при фильтре в поставке остался один документ — скобки нет, строка обычная', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000006';
    const { rows } = buildMachineRows(
      [doc('a', { portalGroupId: m, machine: machine(m, 3) })],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });
});
