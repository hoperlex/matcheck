/**
 * Пакетные предупреждения обязаны переживать пересчёт validation.
 *
 * validateUpdTotals собирает вердикт с нуля по позициям и шапке — так и надо
 * для арифметических подозрений. Но «в файле были неразобранные страницы» и
 * «номеру со страницы не нашлось документа» относятся к нарезке пакета, а не к
 * числам документа: пересчитать их нечем, и без переноса они исчезали бы при
 * первой же ручной правке или повторном разборе.
 */
import { describe, expect, it } from 'vitest';
import { mergePersistentUpdWarnings } from '../src/domain/edo/upd-validation.js';
import type { UpdValidation } from '@matcheck/contracts';

const base = (warnings?: UpdValidation['warnings']): UpdValidation => ({
  hasMismatch: false,
  checkedAt: '2026-09-03T00:00:00.000Z',
  checks: [],
  ...(warnings ? { warnings } : {}),
});

describe('mergePersistentUpdWarnings', () => {
  it('переносит пакетное предупреждение в новый снимок', () => {
    const merged = mergePersistentUpdWarnings(
      base([{ name: 'dropped_pages_not_parsed', scope: 'document' }]),
      base(),
    );
    expect(merged.warnings).toEqual([{ name: 'dropped_pages_not_parsed', scope: 'document' }]);
  });

  it('арифметические подозрения не переносит — их считают заново', () => {
    const merged = mergePersistentUpdWarnings(
      base([{ name: 'qty_price_swap', scope: { row: 1 } }]),
      base(),
    );
    expect(merged.warnings).toBeUndefined();
  });

  it('не создаёт дублей, если пересчёт уже выставил то же имя', () => {
    const w = { name: 'sibling_number_gap', scope: 'document' } as const;
    const merged = mergePersistentUpdWarnings(base([w]), base([w]));
    expect(merged.warnings).toHaveLength(1);
  });

  it('складывает новые арифметические и старые пакетные', () => {
    const merged = mergePersistentUpdWarnings(
      base([{ name: 'page_doc_number_unaccounted', scope: 'document' }]),
      base([{ name: 'qty_price_swap', scope: { row: 2 } }]),
    );
    expect(merged.warnings?.map((w) => w.name)).toEqual([
      'qty_price_swap',
      'page_doc_number_unaccounted',
    ]);
  });

  it('без устойчивых предупреждений — чистый no-op, тот же объект', () => {
    const next = base([{ name: 'unit_price_one', scope: { row: 1 } }]);
    expect(mergePersistentUpdWarnings(base(), next)).toBe(next);
    expect(mergePersistentUpdWarnings(null, next)).toBe(next);
    expect(mergePersistentUpdWarnings(undefined, next)).toBe(next);
  });

  it('hasMismatch и checks остаются от нового снимка', () => {
    const next: UpdValidation = {
      hasMismatch: true,
      checkedAt: '2026-09-03T10:00:00.000Z',
      checks: [],
    };
    const merged = mergePersistentUpdWarnings(
      base([{ name: 'dropped_pages_not_parsed', scope: 'document' }]),
      next,
    );
    expect(merged.hasMismatch).toBe(true);
    expect(merged.checkedAt).toBe('2026-09-03T10:00:00.000Z');
  });
});
