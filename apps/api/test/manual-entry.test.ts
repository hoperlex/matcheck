import { describe, expect, it } from 'vitest';
import {
  decideManualOnCreate,
  firstCommentLine,
  manualEntryViolation,
} from '../src/domain/operations/manual-entry.js';

const tabletDelivery = {
  statusCode: 'confirmed_mol',
  vehiclePlate: null,
  sourceDocumentIds: [] as string[],
  inTransit: false,
  comment: 'Ручной внос\nКомментарий: "x"\nПримечание: УПД 12',
};

describe('firstCommentLine', () => {
  it('берёт первую строку и срезает \\r', () => {
    expect(firstCommentLine('Ручной внос\r\nКомментарий')).toBe('Ручной внос');
    expect(firstCommentLine('Ручной вынос')).toBe('Ручной вынос');
    expect(firstCommentLine(null)).toBe('');
  });
});

describe('decideManualOnCreate — подпись планшета', () => {
  it('маркер + допустимый вид → ручной', () => {
    expect(decideManualOnCreate('delivery', tabletDelivery)).toEqual({ ok: true, isManual: true });
  });

  it('маркер не первой строкой → не ручной («1 Этап: \\"ручной внос\\"»)', () => {
    expect(
      decideManualOnCreate('delivery', { ...tabletDelivery, comment: '1 Этап: "ручной внос"' }),
    ).toEqual({ ok: true, isManual: false });
  });

  it('офлайн-обычная (сразу confirmed_mol, без маркера) → не ручной', () => {
    expect(
      decideManualOnCreate('delivery', { ...tabletDelivery, comment: null, vehiclePlate: 'А1' }),
    ).toEqual({ ok: true, isManual: false });
  });

  it.each([
    ['номер', { vehiclePlate: 'БН' }],
    ['документы', { sourceDocumentIds: ['a'] }],
    ['не сразу подтверждена', { statusCode: 'filled' }],
    ['транзит', { inTransit: true }],
  ])('маркер, но %s → не ручной и БЕЗ отказа', (_n, patch) => {
    expect(decideManualOnCreate('delivery', { ...tabletDelivery, ...patch })).toEqual({
      ok: true,
      isManual: false,
    });
  });

  it('маркер выноса у приёмки не считается', () => {
    expect(
      decideManualOnCreate('delivery', { ...tabletDelivery, comment: 'Ручной вынос' }),
    ).toEqual({ ok: true, isManual: false });
  });

  it('ручной вынос: contractor → да, transfer → нет', () => {
    const sh = { ...tabletDelivery, comment: 'Ручной вынос', kind: 'contractor' };
    expect(decideManualOnCreate('shipment', sh)).toEqual({ ok: true, isManual: true });
    expect(decideManualOnCreate('shipment', { ...sh, kind: 'transfer' })).toEqual({
      ok: true,
      isManual: false,
    });
  });
});

describe('decideManualOnCreate — явный флаг портала', () => {
  const portal = { ...tabletDelivery, comment: 'с портала', isManual: true };

  it('допустимая запись → ручной', () => {
    expect(decideManualOnCreate('delivery', portal)).toEqual({ ok: true, isManual: true });
  });

  it('недопустимая → отказ с причиной', () => {
    const r = decideManualOnCreate('delivery', { ...portal, vehiclePlate: 'А1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/без госномера/);
    const t = decideManualOnCreate('shipment', { ...portal, kind: 'transfer' });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.message).toMatch(/перемещением/);
  });

  it('явный false перекрывает маркер', () => {
    expect(decideManualOnCreate('delivery', { ...tabletDelivery, isManual: false })).toEqual({
      ok: true,
      isManual: false,
    });
  });
});

describe('manualEntryViolation', () => {
  it('пробелы в номере номером не считаются', () => {
    expect(manualEntryViolation('delivery', { ...tabletDelivery, vehiclePlate: '  ' })).toBeNull();
  });
});
