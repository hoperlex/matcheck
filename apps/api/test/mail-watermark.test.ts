/**
 * Watermark опроса ящика.
 *
 * Цена ошибки здесь — потерянный УПД: если граница перешагнёт письмо, которое
 * не удалось забрать, оно больше не попадёт в выборку `uid > last_uid` никогда.
 * Поэтому граница двигается только по непрерывному префиксу терминальных
 * записей, а не по максимальному терминальному UID.
 */
import { describe, expect, it } from 'vitest';
import {
  computeWatermark,
  isTerminal,
  needsWatermarkReset,
  RECEIPT_MAX_ATTEMPTS,
  type ReceiptState,
} from '../src/domain/mail/watermark.js';

const r = (uid: number, status: ReceiptState['status'], attempts = 0): ReceiptState => ({
  uid,
  status,
  attempts,
});

describe('терминальность записи', () => {
  it('успех, пропуск по размеру и исчезнувшее письмо — терминальны', () => {
    expect(isTerminal(r(1, 'parsed'))).toBe(true);
    expect(isTerminal(r(1, 'skipped_by_size'))).toBe(true);
    expect(isTerminal(r(1, 'vanished'))).toBe(true);
  });

  it('письмо в работе — нет', () => {
    expect(isTerminal(r(1, 'fetching'))).toBe(false);
  });

  it('ошибка терминальна только после исчерпания попыток', () => {
    expect(isTerminal(r(1, 'fetch_failed', 1))).toBe(false);
    expect(isTerminal(r(1, 'fetch_failed', RECEIPT_MAX_ATTEMPTS))).toBe(true);
    expect(isTerminal(r(1, 'parse_failed', RECEIPT_MAX_ATTEMPTS - 1))).toBe(false);
    expect(isTerminal(r(1, 'parse_failed', RECEIPT_MAX_ATTEMPTS))).toBe(true);
  });
});

describe('движение границы', () => {
  it('подряд обработанные письма двигают границу до последнего', () => {
    expect(computeWatermark(9, [r(10, 'parsed'), r(11, 'parsed'), r(12, 'parsed')])).toBe(12);
  });

  it('упавшее письмо останавливает границу, даже если следующее успешно', () => {
    // Ключевой случай: UID 10 сорвался, UID 11 прошёл. Сдвинуть границу на 11
    // означало бы потерять десятое письмо навсегда.
    expect(computeWatermark(9, [r(10, 'fetch_failed', 1), r(11, 'parsed')])).toBe(9);
  });

  it('письмо в работе тоже останавливает границу', () => {
    expect(computeWatermark(9, [r(10, 'fetching'), r(11, 'parsed')])).toBe(9);
  });

  it('после исчерпания попыток граница идёт дальше', () => {
    expect(
      computeWatermark(9, [r(10, 'fetch_failed', RECEIPT_MAX_ATTEMPTS), r(11, 'parsed')]),
    ).toBe(11);
  });

  it('порядок записей значения не имеет', () => {
    expect(computeWatermark(9, [r(12, 'parsed'), r(10, 'parsed'), r(11, 'parsed')])).toBe(12);
    expect(computeWatermark(9, [r(11, 'parsed'), r(10, 'fetching')])).toBe(9);
  });

  it('граница не откатывается назад', () => {
    // Сервер может повторно отдать старые письма — это не повод сдвигать
    // границу вниз и перечитывать всё заново.
    expect(computeWatermark(20, [r(5, 'parsed'), r(6, 'parsed')])).toBe(20);
  });

  it('старые письма не ломают префикс новых', () => {
    expect(computeWatermark(10, [r(5, 'fetching'), r(11, 'parsed'), r(12, 'parsed')])).toBe(12);
  });

  it('пустой проход границу не двигает', () => {
    expect(computeWatermark(7, [])).toBe(7);
  });

  it('дыра в нумерации не мешает: пропущенных UID на сервере нет', () => {
    // Удалённые письма не возвращаются сервером вовсе, поэтому 10 → 14 — норма.
    expect(computeWatermark(9, [r(10, 'parsed'), r(14, 'parsed')])).toBe(14);
  });
});

describe('смена нумерации ящика', () => {
  it('изменившийся UIDVALIDITY требует сброса', () => {
    expect(needsWatermarkReset(100, 200)).toBe(true);
  });

  it('та же нумерация — сброс не нужен', () => {
    expect(needsWatermarkReset(100, 100)).toBe(false);
  });

  it('первый опрос ящика сбросом не считается', () => {
    expect(needsWatermarkReset(null, 100)).toBe(false);
  });
});
