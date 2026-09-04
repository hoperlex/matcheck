import { describe, it, expect } from 'vitest';
import type { UpdValidation } from '@matcheck/contracts';
import {
  documentsNeedingRowIds,
  hasRowScopedProblems,
  summarizeForOperation,
} from '../src/domain/operations/source-document-validation.js';

/**
 * Сводка сверки для карточки операции.
 *
 * Главное, что здесь закреплено: у здорового документа поля нет ВОВСЕ (а не
 * `null`) — на этом держится обещание «ничего не изменилось для тех, у кого всё
 * в порядке», и подсветка строк идёт по id позиций, а не по номеру строки.
 */

function check(
  over: Partial<UpdValidation['checks'][number]> = {},
): UpdValidation['checks'][number] {
  return {
    name: 'row_qty_price',
    scope: { row: 1 },
    expected: 100,
    actual: 10,
    diff: 90,
    tolerance: 1,
    ok: false,
    ...over,
  };
}

function validation(over: Partial<UpdValidation> = {}): UpdValidation {
  return {
    hasMismatch: true,
    checkedAt: '2026-09-04T00:00:00.000Z',
    checks: [check()],
    ...over,
  };
}

describe('сводка сверки документа для карточки операции', () => {
  it('здоровый документ: поля нет вовсе, ответ не меняется', () => {
    const summary = summarizeForOperation(
      validation({ hasMismatch: false, checks: [check({ ok: true })] }),
      ['00000000-0000-0000-0000-000000000001'],
    );
    expect(summary).toBeUndefined();
  });

  it('документа без снимка (не-УПД, старая запись) сводка не получает', () => {
    expect(summarizeForOperation(null)).toBeUndefined();
    expect(summarizeForOperation(undefined)).toBeUndefined();
  });

  it('пропущенная проверка — не проблема: сверять было нечем', () => {
    const summary = summarizeForOperation(
      validation({
        hasMismatch: false,
        checks: [check({ ok: false, skipReason: 'no_expected' })],
      }),
    );
    expect(summary).toBeUndefined();
  });

  it('расхождение по строкам: номера переводятся в id позиций по порядку', () => {
    const ids = [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ];
    const summary = summarizeForOperation(
      validation({
        checks: [
          check({ scope: { row: 1 } }),
          check({ scope: { row: 3 } }),
          check({ scope: { row: 2 }, ok: true }),
          check({ name: 'items_count', scope: 'document', ok: true, actual: 3 }),
        ],
      }),
      ids,
    );
    expect(summary?.failedChecks).toHaveLength(2);
    expect(summary?.problemItemIds).toEqual([ids[0], ids[2]]);
  });

  it('только подозрения: сводка есть, hasMismatch остаётся false', () => {
    // Кейс из боевых замечаний: арифметика сошлась, но в количестве стоит код
    // единицы измерения. Именно поэтому признак очереди — checks ИЛИ warnings.
    const summary = summarizeForOperation(
      validation({
        hasMismatch: false,
        checks: [check({ ok: true })],
        warnings: [{ name: 'unit_code_as_qty', scope: { row: 1 } }],
      }),
      ['00000000-0000-0000-0000-000000000001'],
    );
    expect(summary?.hasMismatch).toBe(false);
    expect(summary?.warnings).toHaveLength(1);
    expect(summary?.failedChecks).toHaveLength(0);
    expect(summary?.problemItemIds).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('устаревший снимок: подсветки нет, текст остаётся', () => {
    // items_count.actual = 5, а позиций сейчас три: снимок описывает другой
    // список (переразбор или ручная правка). Красить строки по нему нельзя.
    const summary = summarizeForOperation(
      validation({
        checks: [
          check({ scope: { row: 1 } }),
          check({ name: 'items_count', scope: 'document', ok: true, actual: 5 }),
        ],
      }),
      ['a', 'b', 'c'].map((x) => `00000000-0000-0000-0000-00000000000${x.charCodeAt(0) - 96}`),
    );
    expect(summary?.failedChecks).toHaveLength(1);
    expect(summary?.problemItemIds).toEqual([]);
  });

  it('номер строки за пределами списка — тоже без подсветки', () => {
    const summary = summarizeForOperation(validation({ checks: [check({ scope: { row: 7 } })] }), [
      '00000000-0000-0000-0000-000000000001',
    ]);
    expect(summary?.failedChecks).toHaveLength(1);
    expect(summary?.problemItemIds).toEqual([]);
  });

  it('без списка позиций сводка считается, подсветки просто нет', () => {
    const summary = summarizeForOperation(validation());
    expect(summary?.failedChecks).toHaveLength(1);
    expect(summary?.problemItemIds).toEqual([]);
  });

  it('документные расхождения не требуют похода в базу за строками', () => {
    const docOnly = validation({
      checks: [check({ name: 'sum_total', scope: 'document' })],
    });
    expect(hasRowScopedProblems(docOnly)).toBe(false);
    expect(hasRowScopedProblems(validation())).toBe(true);
    expect(hasRowScopedProblems(null)).toBe(false);

    expect(
      documentsNeedingRowIds([
        { id: 'doc-row', validation: validation() },
        { id: 'doc-document-only', validation: docOnly },
        { id: 'doc-clean', validation: null },
      ]),
    ).toEqual(['doc-row']);
  });
});
