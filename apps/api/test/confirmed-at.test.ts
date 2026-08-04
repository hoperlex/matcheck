/**
 * Разбор клиентского времени подтверждения (`confirmedByMolAt`).
 *
 * Ценность этих тестов — в клампах: строка приходит с планшета, где часы может
 * увести пользователь. Сам сценарий, ради которого поле появилось, описан в
 * domain/operations/confirmed-at.ts — ночь 04.08 на ЖК АЛИЯ, когда очередь
 * простояла 5 часов и сервер проставил четырём приёмкам одно время.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveConfirmedAt } from '../src/domain/operations/confirmed-at.js';

const NOW = new Date('2026-08-04T05:23:00.000Z');
const iso = (d: Date) => d.toISOString();

describe('resolveConfirmedAt', () => {
  it('берёт время планшета, даже если мутация доехала часами позже', () => {
    // Ровно случай АЛИЯ: инспектор закрыл 2 Этап в 23:05, доставка — в 05:23.
    const actual = new Date('2026-08-03T20:05:00.000Z');

    const result = resolveConfirmedAt({
      raw: iso(actual),
      lowerBound: new Date('2026-08-03T20:05:00.000Z'),
      now: NOW,
      entity: 'delivery',
    });

    expect(iso(result)).toBe(iso(actual));
  });

  it('без поля ставит серверное время — совместимость со сборками до 1.0.33', () => {
    expect(iso(resolveConfirmedAt({ now: NOW, entity: 'delivery' }))).toBe(iso(NOW));
    expect(iso(resolveConfirmedAt({ raw: null, now: NOW, entity: 'shipment' }))).toBe(iso(NOW));
  });

  it('невалидную строку заменяет серверным временем', () => {
    expect(iso(resolveConfirmedAt({ raw: 'не дата', now: NOW, entity: 'delivery' }))).toBe(iso(NOW));
    expect(iso(resolveConfirmedAt({ raw: '', now: NOW, entity: 'delivery' }))).toBe(iso(NOW));
  });

  it('небольшое расхождение часов вперёд принимает как есть', () => {
    // 4 минуты вперёд — обычный дрейф часов, не аномалия.
    const slightlyAhead = new Date(NOW.getTime() + 4 * 60 * 1000);

    const result = resolveConfirmedAt({ raw: iso(slightlyAhead), now: NOW, entity: 'delivery' });

    expect(iso(result)).toBe(iso(slightlyAhead));
  });

  it('время из будущего за пределом допуска срезает до серверного', () => {
    const farAhead = new Date(NOW.getTime() + 60 * 60 * 1000);

    const result = resolveConfirmedAt({ raw: iso(farAhead), now: NOW, entity: 'delivery' });

    expect(iso(result)).toBe(iso(NOW));
  });

  it('время раньше заезда поднимает до заезда', () => {
    const arrived = new Date('2026-08-04T05:00:00.000Z');
    const tooEarly = new Date('2026-08-04T04:00:00.000Z');

    const result = resolveConfirmedAt({
      raw: iso(tooEarly),
      lowerBound: arrived,
      now: NOW,
      entity: 'delivery',
    });

    expect(iso(result)).toBe(iso(arrived));
  });

  it('то же для отгрузки — нижняя граница shippedAt', () => {
    const shipped = new Date('2026-08-04T05:10:00.000Z');

    const result = resolveConfirmedAt({
      raw: '2026-08-04T04:30:00.000Z',
      lowerBound: iso(shipped),
      now: NOW,
      entity: 'shipment',
    });

    expect(iso(result)).toBe(iso(shipped));
  });

  it('сломанные часы (нижняя граница выше верхней) → серверное время и лог', () => {
    // arrivedAt в будущем на сутки: планшет пришёл с уехавшими часами, обе
    // границы бессмысленны — доверять нечему.
    const warn = vi.fn();

    const result = resolveConfirmedAt({
      raw: '2026-08-05T05:00:00.000Z',
      lowerBound: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      now: NOW,
      log: { warn },
      entity: 'delivery',
      id: 'd-1',
    });

    expect(iso(result)).toBe(iso(NOW));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ entity: 'delivery', id: 'd-1' });
  });

  it('нижняя граница не мешает, когда её нет', () => {
    const actual = new Date('2026-08-04T05:20:00.000Z');

    const result = resolveConfirmedAt({
      raw: iso(actual),
      lowerBound: null,
      now: NOW,
      entity: 'delivery',
    });

    expect(iso(result)).toBe(iso(actual));
  });
});
