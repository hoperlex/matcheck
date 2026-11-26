import { describe, expect, it } from 'vitest';
import { formatIsoDayRu } from './formatRu';

describe('formatIsoDayRu', () => {
  it.each([
    ['2026-11-25', '25.11.2026'],
    // Время события — не календарная дата документа: без часового пояса
    // взяли бы день по UTC, поэтому строка остаётся как есть.
    ['2026-11-25T21:30:00Z', '2026-11-25T21:30:00Z'],
    // Уже русская: new Date() прочитал бы её как 6 января.
    ['01.06.2026', '01.06.2026'],
    // Свободный текст распознавания.
    ['25 ноября 2026 г.', '25 ноября 2026 г.'],
  ])('%s → %s', (input, expected) => {
    expect(formatIsoDayRu(input)).toBe(expected);
  });

  it('пусто — прочерк', () => {
    expect(formatIsoDayRu(null)).toBe('—');
    expect(formatIsoDayRu(undefined)).toBe('—');
    expect(formatIsoDayRu('')).toBe('—');
  });
});
