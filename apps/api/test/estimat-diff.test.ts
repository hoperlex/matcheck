/**
 * Правила журнала заказа (виза снята / поставлена / поставлена повторно,
 * стадия, возвращение) и сопоставление объекта по коду.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_SITE_ID } from '../src/db/schema.js';
import { diffOrder, matchSite, type OrderPrevState } from '../src/domain/estimat/order-diff.js';

const A = new Date('2026-10-22T12:40:11.000Z');
const B = new Date('2026-10-25T08:00:00.000Z');
const prev = (patch: Partial<OrderPrevState> = {}): OrderPrevState => ({
  supplyApprovedAt: null,
  sourcingStatus: 'awarded',
  deletedAt: null,
  ...patch,
});
const kinds = (events: { kind: string }[]) => events.map((e) => e.kind);

describe('diffOrder', () => {
  it('первое появление без визы — только first_seen', () => {
    const ev = diffOrder(null, { supplyApprovedAt: null, sourcingStatus: 'sourcing' }, false);
    expect(kinds(ev)).toEqual(['first_seen']);
    expect(ev[0]!.details).toEqual({ stage: 'sourcing', supplyApprovedAt: null });
  });

  it('первое появление с визой — first_seen и approved', () => {
    const ev = diffOrder(null, { supplyApprovedAt: A, sourcingStatus: 'awarded' }, false);
    expect(kinds(ev)).toEqual(['first_seen', 'approved']);
    expect(ev[1]).toMatchObject({ fromValue: null, toValue: A.toISOString() });
  });

  it('согласован → снят → согласован повторно', () => {
    expect(kinds(diffOrder(prev(), { supplyApprovedAt: A, sourcingStatus: 'awarded' }, false))).toEqual(['approved']);
    const revoked = diffOrder(prev({ supplyApprovedAt: A }), { supplyApprovedAt: null, sourcingStatus: 'awarded' }, true);
    expect(revoked).toEqual([
      { kind: 'approval_revoked', fromValue: A.toISOString(), toValue: null, details: null },
    ]);
    const again = diffOrder(prev(), { supplyApprovedAt: B, sourcingStatus: 'awarded' }, true);
    expect(again).toEqual([{ kind: 'reapproved', fromValue: null, toValue: B.toISOString(), details: null }]);
  });

  it('впервые увиден с визой → снят → новая виза = reapproved', () => {
    // hadApproval=true: approved записан вместе с first_seen.
    const first = diffOrder(null, { supplyApprovedAt: A, sourcingStatus: 'awarded' }, false);
    const hadApproval = first.some((e) => e.kind === 'approved');
    expect(hadApproval).toBe(true);
    const again = diffOrder(prev({ supplyApprovedAt: null }), { supplyApprovedAt: B, sourcingStatus: 'awarded' }, hadApproval);
    expect(kinds(again)).toEqual(['reapproved']);
  });

  it('дата визы сменилась без null между обходами — reapproved со старой и новой датой', () => {
    const ev = diffOrder(prev({ supplyApprovedAt: A }), { supplyApprovedAt: B, sourcingStatus: 'awarded' }, true);
    expect(ev).toEqual([
      { kind: 'reapproved', fromValue: A.toISOString(), toValue: B.toISOString(), details: null },
    ]);
  });

  it('та же дата другим объектом Date — без событий', () => {
    const ev = diffOrder(prev({ supplyApprovedAt: A }), { supplyApprovedAt: new Date(A.getTime()), sourcingStatus: 'awarded' }, true);
    expect(ev).toEqual([]);
  });

  it('стадия и возвращение удалённого', () => {
    const ev = diffOrder(
      prev({ sourcingStatus: 'awarded', deletedAt: A }),
      { supplyApprovedAt: null, sourcingStatus: 'cancelled' },
      false,
    );
    expect(kinds(ev)).toEqual(['restored', 'status_changed']);
    expect(ev[1]).toMatchObject({ fromValue: 'awarded', toValue: 'cancelled' });
  });
});

describe('matchSite', () => {
  const sites = [
    { id: 's1', code: 'ЗИЛ33' },
    { id: 's2', code: 'СОБ62' },
    { id: 's3', code: 'ab' },
    { id: 's4', code: 'AB' },
    { id: SYSTEM_SITE_ID, code: 'NA' },
  ];

  it('точное совпадение и обрезка пробелов', () => {
    expect(matchSite('ЗИЛ33', sites)).toEqual({ siteId: 's1', status: 'matched' });
    expect(matchSite('  СОБ62 ', sites)).toEqual({ siteId: 's2', status: 'matched' });
  });

  it('без учёта регистра — только если кандидат один', () => {
    expect(matchSite('зил33', sites)).toEqual({ siteId: 's1', status: 'matched' });
    // ab и AB — два кандидата без учёта регистра: точного нет → неоднозначно.
    expect(matchSite('Ab', sites)).toEqual({ siteId: null, status: 'ambiguous' });
    // Точное совпадение выигрывает и при наличии регистрового двойника.
    expect(matchSite('AB', sites)).toEqual({ siteId: 's4', status: 'matched' });
  });

  it('нет кода, не найден, системный объект не выбирается', () => {
    expect(matchSite(null, sites)).toEqual({ siteId: null, status: 'no_code' });
    expect(matchSite('   ', sites)).toEqual({ siteId: null, status: 'no_code' });
    expect(matchSite('НЕТ', sites)).toEqual({ siteId: null, status: 'not_found' });
    expect(matchSite('NA', sites)).toEqual({ siteId: null, status: 'not_found' });
  });
});
