/**
 * Время события ленты.
 *
 * Повод боевой: разведка ящика 24.09.2026 прошла две тысячи событий и не нашла
 * ни одной даты — `Timestamp` у события ленты пуст. Из него же заполняется
 * «когда пришёл документ» при импорте, так что все карточки приехали бы без
 * этого поля, и заметить это было бы негде.
 */
import { describe, it, expect } from 'vitest';
import { resolveEventTime, diadocTimestampToDate } from '../src/domain/edo/diadoc.types.js';

/** 2026-09-24T10:00:00Z в тиках .NET. */
const TICKS = String(BigInt(Date.parse('2026-09-24T10:00:00.000Z')) * 10_000n + 621_355_968_000_000_000n);

describe('время события', () => {
  it('берётся из события, когда оно там есть', () => {
    const r = resolveEventTime({ Timestamp: TICKS });
    expect(r.source).toBe('event');
    expect(r.at?.toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it('берётся из сообщения, когда у события его нет', () => {
    // Ровно случай боевого ящика.
    const r = resolveEventTime({ Message: { Timestamp: TICKS } });
    expect(r.source).toBe('message');
    expect(r.at?.toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it('событие важнее сообщения, если заполнены оба', () => {
    const later = String(BigInt(Date.parse('2026-09-25T10:00:00.000Z')) * 10_000n + 621_355_968_000_000_000n);
    const r = resolveEventTime({ Timestamp: TICKS, Message: { Timestamp: later } });
    expect(r.at?.toISOString()).toBe('2026-09-24T10:00:00.000Z');
  });

  it('отсутствие времени не считается ошибкой', () => {
    // Проход не должен падать: время — полезное поле, но не обязательное.
    const r = resolveEventTime({ Message: { MessageId: 'm-1' } as { Timestamp?: string } });
    expect(r).toEqual({ at: null, source: null });
  });

  it('ISO-строка разбирается наравне с тиками', () => {
    expect(resolveEventTime({ Timestamp: '2026-09-24T10:00:00Z' }).at?.toISOString()).toBe(
      '2026-09-24T10:00:00.000Z',
    );
  });

  it('число читается как тики .NET, а не как миллисекунды Unix', () => {
    // Зафиксировано намеренно: Диадок отдаёт тики от 0001-01-01. Если бы
    // когда-нибудь пришли миллисекунды, они дали бы дату до 1970 года — такой
    // результат заметен глазом и в тесте, а не растечётся по документам.
    const asTicks = diadocTimestampToDate(1_700_000_000_000);
    expect(asTicks?.getUTCFullYear()).toBeLessThan(1970);
  });
});
