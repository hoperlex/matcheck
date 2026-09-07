import { describe, it, expect } from 'vitest';
import { countCoveredDocumentItems } from '../src/domain/operations/source-document-validation.js';

/**
 * Сколько позиций документа доехало до операции.
 *
 * Приёмка 13157: в УПД три позиции, в приёмке две, и увидеть это было негде.
 * За месяц таких приёмок 90–117, ещё у 58–69 не связано ни одной позиции.
 */

const DOC = '00000000-0000-0000-0000-0000000000d1';
const OTHER = '00000000-0000-0000-0000-0000000000d2';

describe('покрытие позиций документа', () => {
  it('считает уникальные позиции по каждому документу', () => {
    const covered = countCoveredDocumentItems([
      { sourceDocumentId: DOC, sourceDocumentItemId: 'i1' },
      { sourceDocumentId: DOC, sourceDocumentItemId: 'i2' },
      { sourceDocumentId: OTHER, sourceDocumentItemId: 'i9' },
    ]);
    expect(covered.get(DOC)).toBe(2);
    expect(covered.get(OTHER)).toBe(1);
  });

  it('задвоенная строка считается один раз — иначе потеря спряталась бы', () => {
    // Классический случай: одна позиция задвоена, другая потеряна. Простой
    // счётчик строк дал бы «3 из 3» и скрыл пропажу.
    const covered = countCoveredDocumentItems([
      { sourceDocumentId: DOC, sourceDocumentItemId: 'i1' },
      { sourceDocumentId: DOC, sourceDocumentItemId: 'i1' },
      { sourceDocumentId: DOC, sourceDocumentItemId: 'i2' },
    ]);
    expect(covered.get(DOC)).toBe(2);
  });

  it('строки без происхождения не учитываются', () => {
    const covered = countCoveredDocumentItems([
      { sourceDocumentId: null, sourceDocumentItemId: null },
      { sourceDocumentId: DOC, sourceDocumentItemId: null },
      { sourceDocumentId: null, sourceDocumentItemId: 'i1' },
    ]);
    expect(covered.size).toBe(0);
  });

  it('пустой список даёт пустую карту', () => {
    expect(countCoveredDocumentItems([]).size).toBe(0);
  });
});
