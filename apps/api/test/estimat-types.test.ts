/**
 * Разбор строк заказов EstiMat: null-поля, несколько подрядчиков, подзаказы,
 * сумма в копейках без float, неизвестные поля. Плюс общие функции контракта —
 * номер заказа для людей и состояние согласования.
 */
import { describe, expect, it } from 'vitest';
import { approvalState, formatOrderNo } from '@matcheck/contracts';
import { innDigits, parseOrderRow, toDecimalString } from '../src/domain/estimat/estimat.types.js';

const ID = '3f6c2a1e-0000-4000-8000-000000000001';

function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    orderNo: 12,
    subNo: 0,
    requestIds: [],
    projectId: '3f6c2a1e-0000-4000-8000-0000000000aa',
    projectCode: 'ЖК01',
    projectName: 'Жилой комплекс «Пример»',
    contractors: [{ id: 'c1', name: 'ООО «Подрядчик»', inn: '7700000000', type: 'subcontractor' }],
    sourcingStatus: 'awarded',
    procurementMethod: 'tender',
    acquisitionType: 'rp_gc',
    supplierName: 'ООО «Поставщик»',
    supplierInn: '7800000000',
    amount: 356400.5,
    contractNumber: null,
    contractDate: null,
    invoiceIsContract: false,
    awardedAt: '2026-10-20T09:15:00.000Z',
    supplyApprovedAt: '2026-10-22T12:40:11.000Z',
    createdAt: '2026-10-15T07:02:44.000Z',
    updatedAt: '2026-10-22T12:40:11.000Z',
    ...patch,
  };
}

describe('parseOrderRow', () => {
  it('разбирает строку из примера ТЗ', () => {
    const r = parseOrderRow(row());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toMatchObject({
      id: ID,
      orderNo: 12,
      subNo: 0,
      projectCode: 'ЖК01',
      supplierInn: '7800000000',
      amount: '356400.50',
      sourcingStatus: 'awarded',
    });
    expect(r.order.supplyApprovedAt?.toISOString()).toBe('2026-10-22T12:40:11.000Z');
    expect(r.order.contractors).toEqual([
      { id: 'c1', name: 'ООО «Подрядчик»', inn: '7700000000', type: 'subcontractor' },
    ]);
  });

  it('null в поставщике, сумме, визе и номере — допустимы', () => {
    const r = parseOrderRow(
      row({
        orderNo: null,
        subNo: null,
        supplierName: null,
        supplierInn: null,
        amount: null,
        supplyApprovedAt: null,
        awardedAt: null,
        sourcingStatus: 'sourcing',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.order).toMatchObject({
      orderNo: null,
      subNo: null,
      supplierName: null,
      supplierInn: null,
      amount: null,
      supplyApprovedAt: null,
      awardedAt: null,
    });
  });

  it('несколько подрядчиков и пустой список; null в ИНН и типе', () => {
    const many = parseOrderRow(
      row({
        contractors: [
          { id: 'a', name: 'А', inn: null, type: 'mol' },
          { id: 'b', name: 'Б', inn: '7700000001', type: null },
        ],
      }),
    );
    expect(many.ok && many.order.contractors.length).toBe(2);
    const none = parseOrderRow(row({ contractors: [] }));
    expect(none.ok && none.order.contractors).toEqual([]);
  });

  it('подзаказ разбирается как самостоятельный заказ', () => {
    const r = parseOrderRow(row({ subNo: 2, supplierInn: '5000000000' }));
    expect(r.ok && r.order.subNo).toBe(2);
  });

  it('неизвестные поля отбрасываются, но строка целиком остаётся в raw', () => {
    const r = parseOrderRow(row({ futureField: { x: 1 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('futureField' in r.order).toBe(false);
    expect(r.order.raw.futureField).toEqual({ x: 1 });
  });

  it('ИНН поставщика — только 10 или 12 цифр, иначе null', () => {
    const bad = parseOrderRow(row({ supplierInn: '12345' }));
    expect(bad.ok && bad.order.supplierInn).toBeNull();
    const spaced = parseOrderRow(row({ supplierInn: ' 78 0000 0000 ' }));
    expect(spaced.ok && spaced.order.supplierInn).toBe('7800000000');
  });

  it('битая строка: id сохраняется, если он валиден', () => {
    const noStage = parseOrderRow(row({ sourcingStatus: undefined }));
    expect(noStage).toMatchObject({ ok: false, id: ID });
    const badId = parseOrderRow(row({ id: 'не-uuid' }));
    expect(badId).toMatchObject({ ok: false, id: null });
    const badDate = parseOrderRow(row({ supplyApprovedAt: 'вчера' }));
    expect(badDate).toMatchObject({ ok: false, id: ID });
  });

  it('сумма с долями копейки — отказ строки, а не молчаливое округление', () => {
    expect(parseOrderRow(row({ amount: 10.005 }))).toMatchObject({ ok: false, id: ID });
  });
});

describe('toDecimalString', () => {
  it('копейки без потерь', () => {
    expect(toDecimalString(356400.5)).toBe('356400.50');
    expect(toDecimalString(0.1 + 0.2)).toBe('0.30');
    expect(toDecimalString(1584000)).toBe('1584000.00');
    expect(toDecimalString(0)).toBe('0.00');
    expect(toDecimalString(-12.34)).toBe('-12.34');
    expect(toDecimalString(99999999999.99)).toBe('99999999999.99');
  });

  it('не число и доли копейки — null', () => {
    expect(toDecimalString(Number.NaN)).toBeNull();
    expect(toDecimalString(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toDecimalString(1.234)).toBeNull();
  });
});

describe('innDigits', () => {
  it('цифры 10/12 знаков, иначе null', () => {
    expect(innDigits('7736255508')).toBe('7736255508');
    expect(innDigits('ИНН 773625550812')).toBe('773625550812');
    expect(innDigits('77362555')).toBeNull();
    expect(innDigits(null)).toBeNull();
  });
});

describe('formatOrderNo', () => {
  it('З-012, З-012/1, без номера', () => {
    expect(formatOrderNo(12, 0)).toBe('З-012');
    expect(formatOrderNo(12, null)).toBe('З-012');
    expect(formatOrderNo(12, 1)).toBe('З-012/1');
    expect(formatOrderNo(1234, 0)).toBe('З-1234');
    expect(formatOrderNo(null, 3)).toBe('без номера');
  });
});

describe('approvalState', () => {
  const at = '2026-10-22T12:40:11.000Z';
  it('стадии и виза', () => {
    expect(approvalState('awarded', at, null)).toBe('approved');
    expect(approvalState('awarded', null, null)).toBe('pending');
    expect(approvalState('forming', null, null)).toBe('pending');
    expect(approvalState('approval', null, null)).toBe('pending');
    expect(approvalState('sourcing', null, null)).toBe('pending');
    // Подрядчик закупает сам — виза не придёт никогда, это не «не согласован».
    expect(approvalState('recorded', null, null)).toBe('not_required');
    expect(approvalState('cancel_pending', at, null)).toBe('cancelling');
    expect(approvalState('cancelled', at, null)).toBe('cancelled');
    expect(approvalState('no_award', null, null)).toBe('cancelled');
    expect(approvalState('something_new', at, null)).toBe('unknown');
  });

  it('удалённый в EstiMat — deleted при любой стадии и визе', () => {
    expect(approvalState('awarded', at, at)).toBe('deleted');
    expect(approvalState('cancelled', null, new Date())).toBe('deleted');
  });
});
