import { describe, expect, it } from 'vitest';
import {
  dispatcherBulkPlan,
  dispatcherBulkResult,
  dispatcherConfirmTitle,
  dispatcherCountsOf,
} from './dispatcherBulk';

const row = (code: string, opts: { checked?: boolean; pending?: boolean } = {}) => ({
  status: { code, label: code, color: null },
  pendingDeletionAt: opts.pending ? '2026-11-18T10:00:00.000Z' : null,
  dispatcherCheckedAt: opts.checked ? '2026-11-18T10:00:00.000Z' : null,
});

describe('«Диспетчер» разом: план кнопки', () => {
  it('часть без отметки — ставить им; все отмечены — снимать; подходящих нет — недоступно', () => {
    expect(dispatcherBulkPlan({ checked: 1, eligible: 3 })).toEqual({
      block: null,
      mode: 'check',
      count: 2,
    });
    expect(dispatcherBulkPlan({ checked: 3, eligible: 3 })).toEqual({
      block: null,
      mode: 'uncheck',
      count: 3,
    });
    expect(dispatcherBulkPlan({ checked: 0, eligible: 0 }).block).toMatch(/Нет оформленных/);
  });

  it('счёт по строкам: неоформленные и помеченные на удаление не в счёт', () => {
    expect(
      dispatcherCountsOf([
        row('filled', { checked: true }),
        row('confirmed_mol'),
        row('not_filled'),
        row('filled', { pending: true, checked: true }),
      ]),
    ).toEqual({ checked: 1, eligible: 2 });
  });

  it('заголовки подтверждения — с числом и падежом', () => {
    expect(dispatcherConfirmTitle({ block: null, mode: 'check', count: 1 }, 'group')).toBe(
      'Отметить «Диспетчер» в группе: 1 приёмка без отметки?',
    );
    expect(dispatcherConfirmTitle({ block: null, mode: 'uncheck', count: 5 }, 'selected')).toBe(
      'Снять отметку «Диспетчер»: 5 приёмок?',
    );
  });
});

describe('«Диспетчер» разом: итог', () => {
  it('изменённые — успех; «уже в этом состоянии» — не пропуск', () => {
    expect(
      dispatcherBulkResult(
        { changed: ['a', 'b'], skipped: [{ id: 'c', reason: 'already' }] },
        true,
      ),
    ).toEqual({ success: 'Отмечено диспетчером: 2 приёмки', warning: null });
  });

  it('пропуски сгруппированы по причине', () => {
    const res = dispatcherBulkResult(
      {
        changed: ['a'],
        skipped: [
          { id: 'b', reason: 'not_reviewable' },
          { id: 'c', reason: 'not_reviewable' },
          { id: 'd', reason: 'pending_deletion' },
        ],
      },
      false,
    );
    expect(res.success).toBe('Отметка диспетчера снята: 1 приёмка');
    expect(res.warning).toBe('Пропущено: 2 — ещё не оформлены; 1 — помечены на удаление');
  });

  it('ничего не изменилось — так и сказано', () => {
    expect(
      dispatcherBulkResult({ changed: [], skipped: [{ id: 'a', reason: 'already' }] }, true),
    ).toEqual({ success: null, warning: 'Все уже отмечены диспетчером' });
  });
});
