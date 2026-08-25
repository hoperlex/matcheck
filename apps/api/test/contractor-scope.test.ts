import { describe, it, expect } from 'vitest';
import { sourceDocumentVisibleToContractor } from '../src/lib/contractor-scope.js';

/**
 * Автоподставленный подрядчик правом доступа не является.
 *
 * Проверка пережила саму автоподстановку: воркер её больше не делает, но
 * документы с `recipient_source='auto_buyer'` остались в базе, и правило «такой
 * подрядчик не даёт роли contractor ничего» продолжает действовать. Оно
 * защищает от простого сценария: прислать на открытую страницу /uploads УПД с
 * чужим ИНН в графе 6 и получить чужие поставки и суммы.
 */
describe('sourceDocumentVisibleToContractor', () => {
  const contractorId = '33333333-3333-3333-3333-333333333333';
  const opIds = [contractorId];

  it('auto_buyer не даёт доступа, а решение человека и ручной ввод — дают', () => {
    expect(
      sourceDocumentVisibleToContractor({ contractorId, recipientSource: 'auto_buyer' }, opIds),
    ).toBe(false);
    expect(
      sourceDocumentVisibleToContractor({ contractorId, recipientSource: 'manual' }, opIds),
    ).toBe(true);
    expect(sourceDocumentVisibleToContractor({ contractorId, recipientSource: null }, opIds)).toBe(
      true,
    );
  });

  it('чужой подрядчик и пользователь без привязки не видят ничего', () => {
    expect(
      sourceDocumentVisibleToContractor(
        { contractorId: 'other', recipientSource: 'manual' },
        opIds,
      ),
    ).toBe(false);
    expect(
      sourceDocumentVisibleToContractor({ contractorId, recipientSource: 'manual' }, null),
    ).toBe(false);
    expect(
      sourceDocumentVisibleToContractor({ contractorId: null, recipientSource: null }, opIds),
    ).toBe(false);
  });
});
