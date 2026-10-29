/**
 * Правило «признак следует за получателем» — полный перебор.
 *
 * Одна функция в контракте, её зовут и сервер (под блокировкой строки), и
 * карточка (подсказка до «Сохранить»). Перебор держит инвариант: после записи
 * получателя признак всегда допустим для него.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedDeliveryPurposes,
  DeliveryPurposeSchema,
  deliveryRecipientKind,
  reconcileDeliveryPurpose,
  type DeliveryPurpose,
  type DeliveryRecipientKind,
} from '@matcheck/contracts';

const KINDS: DeliveryRecipientKind[] = [null, 'contractor', 'mol'];
const PURPOSES: (DeliveryPurpose | null)[] = [null, ...DeliveryPurposeSchema.options];

describe('allowedDeliveryPurposes', () => {
  it('у подрядчика нет «Свои силы», при МОЛ и без получателя — все пять', () => {
    expect(allowedDeliveryPurposes('contractor')).toEqual([
      'realization',
      'tolling_act',
      'contractor_materials',
      'realization_tolling',
    ]);
    expect(allowedDeliveryPurposes('mol')).toHaveLength(5);
    expect(allowedDeliveryPurposes(null)).toHaveLength(5);
  });
});

describe('deliveryRecipientKind', () => {
  it('МОЛ важнее подрядчика (как у планшета), пусто — никто', () => {
    expect(deliveryRecipientKind({ contractorId: 'c', recipientMolId: 'm' })).toBe('mol');
    expect(deliveryRecipientKind({ contractorId: 'c', recipientMolId: null })).toBe('contractor');
    expect(deliveryRecipientKind({ contractorId: null, recipientMolId: null })).toBeNull();
  });
});

describe('reconcileDeliveryPurpose — перебор', () => {
  for (const prev of KINDS) {
    for (const next of KINDS) {
      for (const purpose of PURPOSES) {
        it(`${prev ?? 'никто'} → ${next ?? 'никто'}, признак ${purpose ?? '—'}`, () => {
          const out = reconcileDeliveryPurpose(prev, next, purpose);
          // Инвариант: результат допустим для нового получателя.
          if (out !== null) expect(allowedDeliveryPurposes(next)).toContain(out);
          if (next === 'mol' && prev !== 'mol') {
            expect(out).toBe('own_forces');
          } else if (next === 'contractor' && purpose === 'own_forces') {
            expect(out).toBeNull();
          } else {
            // Во всех прочих случаях ручной выбор не трогается.
            expect(out).toBe(purpose);
          }
        });
      }
    }
  }
});
