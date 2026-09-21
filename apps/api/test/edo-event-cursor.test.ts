/**
 * Продвижение курсора по ленте Диадока.
 *
 * Здесь проверяется ровно один класс потери: событие, застрявшее в середине
 * страницы. Если курсор перешагнёт его, к документу не вернётся никто — в
 * портале его просто не будет, без ошибки и без следа. Поэтому курсор обязан
 * останавливаться на первом незакрытом событии, даже если все следующие прошли.
 */
import { describe, it, expect } from 'vitest';
import {
  EDO_RECEIPT_MAX_ATTEMPTS,
  advanceCursor,
  isEventTerminal,
  isReceiptTerminal,
  terminalPrefixLength,
} from '../src/domain/edo/event-cursor.js';

const stored = { transportStatus: 'stored', attempts: 1 };
const fetching = { transportStatus: 'fetching', attempts: 1 };
const failedOnce = { transportStatus: 'failed', attempts: 1 };
const failedOut = { transportStatus: 'failed', attempts: EDO_RECEIPT_MAX_ATTEMPTS };

function ev(id: string, receipts: { transportStatus: string; attempts: number }[]) {
  return { eventId: id, indexKey: `idx-${id}`, receipts };
}

describe('терминальность вложения', () => {
  it('сохранённое и пропущенное закрыты, а качающееся — нет', () => {
    expect(isReceiptTerminal(stored)).toBe(true);
    expect(isReceiptTerminal({ transportStatus: 'skipped', attempts: 1 })).toBe(true);
    expect(isReceiptTerminal({ transportStatus: 'vanished', attempts: 1 })).toBe(true);
    expect(isReceiptTerminal(fetching)).toBe(false);
  });

  it('сбой закрывает вложение только после исчерпания попыток', () => {
    expect(isReceiptTerminal(failedOnce)).toBe(false);
    expect(isReceiptTerminal(failedOut)).toBe(true);
  });

  it('вложение, ждущее разбора, для курсора закрыто', () => {
    // Транспорт своё дело сделал: файл в хранилище. Иначе первый же скан
    // застопорил бы весь ящик, и следующие за ним УПД не приехали бы никогда.
    expect(isReceiptTerminal(stored)).toBe(true);
  });
});

describe('терминальность события', () => {
  it('событие без вложений закрыто сразу', () => {
    expect(isEventTerminal(ev('1', []))).toBe(true);
  });

  it('событие закрыто, только когда закрыты все его вложения', () => {
    expect(isEventTerminal(ev('1', [stored, stored]))).toBe(true);
    expect(isEventTerminal(ev('1', [stored, fetching]))).toBe(false);
  });
});

describe('продвижение курсора', () => {
  it('идёт до последнего непрерывно закрытого события', () => {
    const events = [ev('a', [stored]), ev('b', [stored]), ev('c', [stored])];
    expect(advanceCursor(null, events)).toBe('idx-c');
  });

  it('останавливается на застрявшем событии, даже если следующие прошли', () => {
    const events = [ev('a', [stored]), ev('b', [failedOnce]), ev('c', [stored])];
    // Ключевая проверка: 'idx-c' здесь означал бы навсегда потерянный документ.
    expect(advanceCursor(null, events)).toBe('idx-a');
    expect(terminalPrefixLength(events)).toBe(1);
  });

  it('не двигается вовсе, если застряло первое событие', () => {
    const events = [ev('a', [fetching]), ev('b', [stored])];
    expect(advanceCursor('idx-prev', events)).toBe('idx-prev');
  });

  it('перешагивает событие, исчерпавшее попытки', () => {
    // Иначе одно битое вложение остановило бы ящик навсегда.
    const events = [ev('a', [failedOut]), ev('b', [stored])];
    expect(advanceCursor(null, events)).toBe('idx-b');
  });

  it('пустая страница оставляет курсор на месте', () => {
    expect(advanceCursor('idx-prev', [])).toBe('idx-prev');
  });
});
