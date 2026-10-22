/**
 * Полнота реестра Диадока за интервал. Вывод «не найдено в Диадоке» делается
 * только при полном реестре, поэтому каждое условие должно ломать полноту само
 * по себе и называть причину.
 */
import { describe, expect, it } from 'vitest';
import { assessDiadocCoverage, type DiadocCoverageRow } from '../src/domain/edo/sbis/diadoc-coverage.js';

const interval = { since: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-10-19T12:00:00Z') };

const good: DiadocCoverageRow = {
  accountId: 'a-1',
  accountName: 'СУ-10',
  provider: 'diadoc',
  cursorSince: new Date('2026-08-01T00:00:00Z'),
  lastFullPassAt: new Date('2026-10-19T12:30:00Z'),
  failedInInterval: 0,
  failedUndated: 0,
};

describe('полнота реестра Диадока', () => {
  it('всё в порядке — полный', () => {
    expect(assessDiadocCoverage([good], interval)).toMatchObject({ covered: true, reasons: [] });
  });

  it.each([
    ['нет курсора', { cursorSince: null }, 'не запускалась'],
    ['курсор позже начала', { cursorSince: new Date('2026-09-02T00:00:00Z') }, 'позже начала интервала'],
    ['нет полного прохода', { lastFullPassAt: null }, 'нет ни одного полного прохода'],
    ['проход раньше конца', { lastFullPassAt: new Date('2026-10-19T11:00:00Z') }, 'раньше конца интервала'],
    ['ошибки за интервал', { failedInInterval: 3 }, '3 УПД с ошибкой выгрузки за интервал'],
    ['ошибки без даты', { failedUndated: 1 }, 'без даты получения'],
  ] as const)('%s — не полный, с причиной', (_name, patch, reason) => {
    const result = assessDiadocCoverage([{ ...good, ...patch }], interval);
    expect(result.covered).toBe(false);
    expect(result.reasons.join('; ')).toContain(reason);
  });

  it('проверяется каждая учётка Диадока: одна неполная — неполный весь реестр', () => {
    const result = assessDiadocCoverage(
      [good, { ...good, accountId: 'a-2', accountName: 'Второй ящик', lastFullPassAt: null }],
      interval,
    );
    expect(result.covered).toBe(false);
    expect(result.accounts.map((a) => a.covered)).toEqual([true, false]);
    expect(result.reasons[0]).toContain('Второй ящик');
  });

  it('учётки не Диадока не учитываются', () => {
    expect(assessDiadocCoverage([good, { ...good, accountId: 's', provider: 'sbis', cursorSince: null }], interval).covered).toBe(
      true,
    );
    expect(assessDiadocCoverage([{ ...good, provider: 'sbis' }], interval)).toMatchObject({
      covered: false,
      reasons: ['нет активных учёток Диадока с выбранным ящиком'],
    });
  });
});
