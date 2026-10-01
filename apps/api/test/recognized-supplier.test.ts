import { describe, expect, it } from 'vitest';
import { decideRecognizedSupplier } from '../src/domain/sourceDocuments/recognized-supplier.js';

const supplier = {
  inn: '7736255508',
  kpp: '771501001',
  name: 'ООО "СУ-10"',
};

describe('decideRecognizedSupplier', () => {
  it('off — строгий no-op, включая невалидный ИНН', () => {
    const invalid = { ...supplier, inn: '7715010100' };
    const decision = decideRecognizedSupplier(invalid, 'off');

    expect(decision.supplier).toBe(invalid);
    expect(decision).toEqual({ supplier: invalid, reason: null, blocked: false });
  });

  it('shadow наблюдает невалидный ИНН, но сохраняет legacy-поведение', () => {
    const invalid = { ...supplier, inn: '7736253508' };
    const decision = decideRecognizedSupplier(invalid, 'shadow');

    expect(decision.supplier).toBe(invalid);
    expect(decision.reason).toBe('invalid_inn');
    expect(decision.blocked).toBe(false);
  });

  it('on блокирует создание и поиск по невалидному непустому ИНН', () => {
    expect(decideRecognizedSupplier({ ...supplier, inn: '127018' }, 'on')).toEqual({
      supplier: null,
      reason: 'invalid_inn',
      blocked: true,
    });
  });

  it('on нормализует валидный ИНН с разделителями', () => {
    const decision = decideRecognizedSupplier({ ...supplier, inn: '77 36-25-55-08' }, 'on');
    expect(decision.supplier?.inn).toBe('7736255508');
    expect(decision.reason).toBeNull();
  });

  it.each(['off', 'shadow', 'on'] as const)('%s сохраняет legacy-путь без ИНН', (mode) => {
    const byName = { ...supplier, inn: null };
    const decision = decideRecognizedSupplier(byName, mode);
    expect(decision.supplier).toBe(byName);
    expect(decision.reason).toBeNull();
  });
});
