import { describe, expect, it } from 'vitest';
import { buildMachineRows, machineHeadSummary, type MachineHeadRow } from './machineGroupRows';

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

  it('строка поставки: номера по видам, принята, «одной отправкой» не пишется', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000004';
    const items = [
      doc('a', { portalGroupId: m, docNumber: 'УТ-134', machine: machine(m, 3, 1, [25840]) }),
      doc('b', { portalGroupId: m, docNumber: 'УТ-135' }),
      doc('c', { portalGroupId: m, docNumber: '85/11', kind: 'transport_waybill' }),
    ];
    const s = machineHeadSummary(buildMachineRows(items, new Set()).rows[0] as MachineHeadRow);
    expect(s.title).toBe('3 документа');
    // Колонка «№» узкая — номера подряд, виды только в подсказке.
    expect(s.numbers).toBe('УТ-134, УТ-135, 85/11');
    expect(s.numbersFull).toBe('УПД УТ-134, УТ-135 · Накладная 85/11');
    expect(s.origin).toBeNull();
    expect(s.merged).toBe(false);
    expect(s.accepted).toEqual({
      label: 'Принята: приёмка 25840',
      full: 'Принята: приёмка 25840',
    });
    expect(s.found).toBeNull();
  });

  it('объединённая машина и фильтр: «объединена из 2 отправок», «найдено 2 из 4»', () => {
    const m = 'aaaaaaaa-0000-0000-0000-000000000005';
    const items = [
      doc('a', { portalGroupId: m, machine: machine(m, 4, 2) }),
      doc('b', { portalGroupId: m, machine: machine(m, 4, 2) }),
    ];
    const s = machineHeadSummary(buildMachineRows(items, new Set()).rows[0] as MachineHeadRow);
    expect(s.origin).toBe('объединена из 2 отправок');
    expect(s.merged).toBe(true);
    expect(s.found).toBe('найдено 2 из 4');
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

describe('строка поставки по колонкам', () => {
  const m = 'cccccccc-0000-0000-0000-000000000001';
  const summaryOf = (items: Row[]) =>
    machineHeadSummary(buildMachineRows(items, new Set()).rows[0] as MachineHeadRow);
  const upd = (id: string, over: Partial<Row> = {}) =>
    doc(id, { portalGroupId: m, siteId: 'site-56', ...over } as Partial<Row>);

  it('сопроводительный файл не попадает в номера — нет «УПД без номера»', () => {
    // Как на бою 24.11: «2 документа · УПД ТП-7724, без номера».
    const s = summaryOf([
      upd('a', { docNumber: 'ТП-7724', machine: machine(m, 2, 1, [27275]) }),
      upd('b', {
        docNumber: null,
        status: 'archived',
        parseErrorCode: 'supplementary',
      } as Partial<Row>),
    ]);
    expect(s.title).toBe('2 документа');
    expect(s.numbers).toBe('ТП-7724');
    expect(s.numbersFull).toBe('УПД ТП-7724');
  });

  it('одна организация с разным написанием — общая сторона; разные ИНН — «разные»', () => {
    const s = summaryOf([
      upd('a', {
        machine: machine(m, 3),
        buyerName: 'ООО "СТРОИТЕЛЬНОЕ УПРАВЛЕНИЕ-10"',
        buyerInn: '7736255508',
        supplierName: 'ООО "А"',
        supplierInn: '7700000001',
      } as Partial<Row>),
      upd('b', {
        buyerName: 'ООО «Строительное управление-10»',
        buyerInn: '7736255508',
        supplierName: 'ООО "Б"',
        supplierInn: '7700000002',
      } as Partial<Row>),
      // Пустое — «неизвестно», а не «другое»: общую сторону не ломает.
      upd('c', { kind: 'transport_waybill', buyerName: null, buyerInn: null } as Partial<Row>),
    ]);
    expect(s.aggregates?.buyer).toMatchObject({ kind: 'same', row: { id: 'a' } });
    expect(s.aggregates?.supplier).toEqual({ kind: 'mixed' });
    expect(s.aggregates?.consignee).toEqual({ kind: 'empty' });
  });

  it('ИНН-заглушка ничего не говорит — сторона сравнивается по названию', () => {
    const s = summaryOf([
      upd('a', {
        machine: machine(m, 2),
        supplierName: 'ИП Иванов',
        supplierInn: '0000000001',
      } as Partial<Row>),
      upd('b', { supplierName: 'ИП Петров', supplierInn: '0000000002' } as Partial<Row>),
    ]);
    expect(s.aggregates?.supplier).toEqual({ kind: 'mixed' });
  });

  it('объект и даты: общие и диапазон', () => {
    const s = summaryOf([
      upd('a', {
        machine: machine(m, 2),
        docDate: '2026-11-23',
        expectedDate: '2026-11-24',
      } as Partial<Row>),
      upd('b', { docDate: '2026-11-24', expectedDate: '2026-11-24' } as Partial<Row>),
    ]);
    expect(s.aggregates?.site).toMatchObject({ kind: 'same', row: { id: 'a' } });
    expect(s.aggregates?.docDate).toEqual({ from: '2026-11-23', to: '2026-11-24' });
    expect(s.aggregates?.expectedDate).toEqual({ from: '2026-11-24', to: '2026-11-24' });
  });

  it('итог — по УПД, без дубликата, архива, сопроводительного и накладной', () => {
    const s = summaryOf([
      upd('a', { machine: machine(m, 5), totalSum: '100.10', vatSum: '16.68' } as Partial<Row>),
      upd('b', { totalSum: '0.20', vatSum: '0.03' } as Partial<Row>),
      upd('dup', {
        status: 'needs_resolution',
        parseErrorCode: 'duplicate_upd',
        totalSum: '100.10',
        vatSum: '16.68',
      } as Partial<Row>),
      upd('arch', { status: 'archived', totalSum: '500.00', vatSum: '83.33' } as Partial<Row>),
      upd('tn', { kind: 'transport_waybill', totalSum: '100.30', vatSum: null } as Partial<Row>),
    ]);
    // 100,10 + 0,20 — ровно 100,30, без хвостов плавающей точки.
    expect(s.aggregates?.totalSum).toEqual({ amount: '100.30', counted: 2, of: 2 });
    expect(s.aggregates?.vatSum).toEqual({ amount: '16.71', counted: 2, of: 2 });
  });

  it('НДС 0,00 у всех УПД — итог «0,00», а не «нет данных»', () => {
    const s = summaryOf([
      upd('a', { machine: machine(m, 2), totalSum: '1000.00', vatSum: '0.00' } as Partial<Row>),
      upd('b', { totalSum: '500.00', vatSum: '0' } as Partial<Row>),
    ]);
    expect(s.aggregates?.vatSum).toEqual({ amount: '0.00', counted: 2, of: 2 });
  });

  it('полнота у «Суммы» и «НДС» своя', () => {
    const s = summaryOf([
      upd('a', { machine: machine(m, 2), totalSum: '1000.00', vatSum: '166.67' } as Partial<Row>),
      upd('b', { totalSum: '500.00', vatSum: null } as Partial<Row>),
    ]);
    expect(s.aggregates?.totalSum).toEqual({ amount: '1500.00', counted: 2, of: 2 });
    expect(s.aggregates?.vatSum).toEqual({ amount: '166.67', counted: 1, of: 2 });

    const t = summaryOf([
      upd('a', { machine: machine(m, 2), totalSum: null, vatSum: '10.00' } as Partial<Row>),
      upd('b', { totalSum: '500.00', vatSum: '20.00' } as Partial<Row>),
    ]);
    expect(t.aggregates?.totalSum).toEqual({ amount: '500.00', counted: 1, of: 2 });
    expect(t.aggregates?.vatSum).toEqual({ amount: '30.00', counted: 2, of: 2 });
  });

  it('ни одной суммы — итога нет', () => {
    const s = summaryOf([
      upd('a', { machine: machine(m, 2), totalSum: null, vatSum: null } as Partial<Row>),
      upd('b', { kind: 'transport_waybill', totalSum: '10.00' } as Partial<Row>),
    ]);
    expect(s.aggregates?.totalSum).toBeNull();
    expect(s.aggregates?.vatSum).toBeNull();
  });

  it('под фильтром машина неполная — обобщений нет, номера найденных есть', () => {
    const s = summaryOf([
      upd('a', {
        machine: machine(m, 3, 2, [27275]),
        docNumber: '1',
        totalSum: '10.00',
      } as Partial<Row>),
      upd('b', { docNumber: '2', totalSum: '20.00' } as Partial<Row>),
    ]);
    expect(s.found).toBe('найдено 2 из 3');
    expect(s.aggregates).toBeNull();
    expect(s.numbers).toBe('1, 2');
    expect(s.accepted?.label).toBe('Принята: приёмка 27275');
    expect(s.origin).toBe('объединена из 2 отправок');
  });

  it('без сводки с сервера машина считается полной по строкам страницы', () => {
    const s = summaryOf([
      upd('a', { totalSum: '10.00' } as Partial<Row>),
      upd('b', { totalSum: '5.00' } as Partial<Row>),
    ]);
    expect(s.found).toBeNull();
    expect(s.aggregates?.totalSum).toEqual({ amount: '15.00', counted: 2, of: 2 });
  });

  it('больше двух приёмок — «и ещё N», полный список в подсказке', () => {
    const s = summaryOf([upd('a', { machine: machine(m, 2, 1, [101, 102, 103, 104]) }), upd('b')]);
    expect(s.accepted).toEqual({
      label: 'Принята: приёмки 101, 102 и ещё 2',
      full: 'Принята: приёмки 101, 102, 103, 104',
    });
  });
});
