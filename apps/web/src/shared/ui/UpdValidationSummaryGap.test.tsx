// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { UpdCheck } from '@matcheck/contracts';
import { describeCheck } from './UpdValidationSummary';

/**
 * Подсказка при расхождении итога зависит от того, сошлись ли строки.
 *
 * Разница стоит рабочего времени: на приёмке 14003 в бумаге «Всего к оплате»
 * 245 060 ₽, строки дают ровно столько же, а модель записала в шапку 245 089 ₽.
 * Прежний текст отправлял искать пропущенную строку, которой нет. Таких
 * документов 56 из 520 за месяц.
 */

const sumTotal: UpdCheck = {
  name: 'sum_total',
  scope: 'document',
  expected: 245089,
  actual: 245060,
  diff: 29,
  tolerance: 0.01,
  ok: false,
};

describe('подсказка при расхождении итога', () => {
  it('строки сошлись — подозрение падает на итог, а не на пропуск строки', () => {
    const text = describeCheck(sumTotal, { rowsAgree: true });
    expect(text).toContain('расходится только итог');
    expect(text).toContain('вероятно, неверно прочитан итог документа');
    expect(text).not.toContain('пропуск строки');
  });

  it('есть построчные претензии — подсказка прежняя, про пропуск строки', () => {
    const text = describeCheck(sumTotal, { rowsAgree: false });
    expect(text).toContain('сумма строк меньше итога');
    expect(text).toContain('проверьте пропуск строки');
  });

  it('без контекста поведение не меняется — старые вызовы целы', () => {
    expect(describeCheck(sumTotal)).toContain('проверьте пропуск строки');
  });

  it('строки сошлись, но разрыв крупный — это не опечатка в итоге', () => {
    // Задвоение строки выглядит так же: каждая строка корректна сама по себе,
    // построчные проверки молчат, а итог расходится. Отличает их размер разрыва.
    const text = describeCheck(
      { ...sumTotal, expected: 2557288, actual: 1513703, diff: 1043585 },
      { rowsAgree: true },
    );
    expect(text).toContain('проверьте пропуск строки');
    expect(text).not.toContain('расходится только итог');
  });

  it('превышение итога описывается задвоением', () => {
    const text = describeCheck({ ...sumTotal, expected: 100, actual: 600, diff: 500 }, {});
    expect(text).toContain('сумма строк больше итога');
    expect(text).toContain('задвоение строки');
  });
});
