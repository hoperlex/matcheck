/**
 * Правило «можно ли править название позиции».
 *
 * Раньше оно было списано в четырёх местах и разъехалось: в таблице приёмки
 * блокировался подрядчик, в карточном режиме — нет, а у отгрузки замка по
 * справочнику не было вовсе. Тест фиксирует единый ответ для всех четырёх.
 */
import { describe, expect, it } from 'vitest';
import { itemNameLock } from './itemNameLock';

const MATERIAL = '11111111-1111-4111-8111-111111111111';

describe('itemNameLock', () => {
  it('право есть, справочного материала нет — правка открыта', () => {
    expect(itemNameLock({ canEdit: true, materialId: null })).toBeNull();
  });

  it('без права правки — причина названа', () => {
    // Роль без operations.*:edit (observer, подрядчик, любая будущая read-only)
    // не должна получать поле ввода ни в таблице, ни в карточном режиме.
    expect(itemNameLock({ canEdit: false, materialId: null })).toBe(
      'Недостаточно прав для правки названия',
    );
  });

  it('позиция из справочника заперта даже при праве правки', () => {
    expect(itemNameLock({ canEdit: true, materialId: MATERIAL })).toBe(
      'Название берётся из справочника материалов',
    );
  });

  it('отсутствие права важнее справочника: причина одна и первая', () => {
    expect(itemNameLock({ canEdit: false, materialId: MATERIAL })).toBe(
      'Недостаточно прав для правки названия',
    );
  });

  it('undefined materialId равнозначен null', () => {
    expect(itemNameLock({ canEdit: true, materialId: undefined })).toBeNull();
  });
});
