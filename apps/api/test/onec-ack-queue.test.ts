/**
 * Таблица правил подтверждения 1С (по тесту на строку), курсор очереди, дата
 * начала из env и разрешённые сети учётки.
 */
import { describe, expect, it } from 'vitest';
import { decideAck, type AckRowState } from '../src/domain/onec/ack.js';
import {
  decodeCursor,
  encodeCursor,
  parseExportSince,
  QueueCursorError,
} from '../src/domain/onec/queue.js';
import { ipAllowed } from '../src/domain/auth/service-accounts.js';

const ID = '11111111-1111-4111-8111-111111111111';
const H = 'a'.repeat(64);
const C = 'c'.repeat(64);
const row = (patch: Partial<AckRowState> = {}): AckRowState => ({
  contentHash: H,
  queueReason: null,
  pendingHash: null,
  ...patch,
});
const ack = (h: string) => ({ id: ID, contentHash: h, hashVersion: 1 });

describe('decideAck — таблица правил', () => {
  it('первое подтверждение (content_hash пуст) — новая версия', () => {
    expect(decideAck(row({ contentHash: null }), ack(H))).toEqual({
      kind: 'store',
      contentHash: H,
      hashVersion: 1,
    });
  });

  it('другой хеш — новая версия (новое окно, пометка снимается)', () => {
    expect(decideAck(row({ queueReason: 'changed', pendingHash: C }), ack(C)).kind).toBe('store');
  });

  it('тот же хеш, а проход нашёл ровно его (правку откатили) — подтверждение найденного', () => {
    expect(decideAck(row({ queueReason: 'changed', pendingHash: H }), ack(H))).toEqual({
      kind: 'confirm_pending',
    });
  });

  it('старое подтверждение H, пока содержимое C, — повтор: пометка остаётся', () => {
    expect(decideAck(row({ queueReason: 'changed', pendingHash: C }), ack(H))).toEqual({
      kind: 'repeat',
    });
  });

  it('повтор без пометки — только журнал', () => {
    expect(decideAck(row(), ack(H))).toEqual({ kind: 'repeat' });
  });

  it('повтор при пометке changed без вычисленного хеша (A2) — не снимает', () => {
    expect(decideAck(row({ queueReason: 'changed', pendingHash: null }), ack(H)).kind).toBe('repeat');
  });

  it('удаление принимается всегда, в том числе для приёмки, которую уже восстановили', () => {
    expect(decideAck(row(), { id: ID, deleted: true })).toEqual({
      kind: 'store',
      contentHash: 'deleted',
      hashVersion: null,
    });
    expect(decideAck(row({ contentHash: null }), { id: ID, deleted: true }).kind).toBe('store');
  });

  it('повтор удаления — только журнал, restored не снимается', () => {
    expect(
      decideAck(row({ contentHash: 'deleted', queueReason: 'restored' }), { id: ID, deleted: true }),
    ).toEqual({ kind: 'repeat' });
  });

  it('ошибка загрузки — только last_error, состояние не трогается', () => {
    expect(decideAck(row({ contentHash: null }), { id: ID, failed: { message: 'нет номенклатуры' } })).toEqual({
      kind: 'error',
      message: 'нет номенклатуры',
    });
  });
});

describe('курсор очереди', () => {
  it('туда и обратно без потерь микросекунд', () => {
    const c = encodeCursor('2026-11-11T08:00:00.123456Z', ID);
    expect(decodeCursor(c)).toEqual({ sortAt: '2026-11-11T08:00:00.123456Z', id: ID });
  });

  it.each(['мусор', Buffer.from('["x","y"]').toString('base64url'), Buffer.from('{}').toString('base64url')])(
    'битый курсор — ошибка, а не обход с начала: %s',
    (c) => {
      expect(() => decodeCursor(c)).toThrow(QueueCursorError);
    },
  );
});

describe('ONEC_EXPORT_SINCE', () => {
  it('дата — полночь по Москве; полный ISO — как есть; мусор — не задано', () => {
    expect(parseExportSince('2026-11-12')).toBe('2026-11-12T00:00:00+03:00');
    expect(parseExportSince('2026-11-12T09:30:00Z')).toBe('2026-11-12T09:30:00Z');
    expect(parseExportSince('12.11.2026')).toBeNull();
    expect(parseExportSince('')).toBeNull();
    expect(parseExportSince(undefined)).toBeNull();
  });
});

describe('ipAllowed', () => {
  it('без списка — любой адрес', () => {
    expect(ipAllowed('203.0.113.5', null)).toBe(true);
    expect(ipAllowed('203.0.113.5', [])).toBe(true);
  });

  it('IPv4, IPv4-mapped IPv6 и одиночный адрес', () => {
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true);
  });

  it('битая запись сети — отказ, а не «пропустить»', () => {
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/99'])).toBe(false);
    expect(ipAllowed('10.1.2.3', ['не сеть'])).toBe(false);
    expect(ipAllowed('не адрес', ['10.0.0.0/8'])).toBe(false);
  });
});
