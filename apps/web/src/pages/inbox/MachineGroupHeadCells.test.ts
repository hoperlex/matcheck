import { describe, expect, it } from 'vitest';
import { formatDateRangeRu } from './MachineGroupHeadCells';

describe('диапазон дат в строке поставки — покороче, колонка узкая', () => {
  it('одна дата — как у документа', () => {
    expect(formatDateRangeRu({ from: '2026-11-24', to: '2026-11-24' })).toBe('24.11.2026');
  });

  it('в пределах месяца — только числа', () => {
    expect(formatDateRangeRu({ from: '2026-11-23', to: '2026-11-24' })).toBe('23–24.11.2026');
  });

  it('в пределах года — число и месяц', () => {
    expect(formatDateRangeRu({ from: '2026-11-30', to: '2026-12-02' })).toBe('30.11–02.12.2026');
  });

  it('через Новый год — полностью', () => {
    expect(formatDateRangeRu({ from: '2025-12-30', to: '2026-01-02' })).toBe(
      '30.12.2025–02.01.2026',
    );
  });
});
