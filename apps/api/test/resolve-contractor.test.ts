import { describe, it, expect } from 'vitest';
import {
  isValidInnChecksum,
  manualRecipientSource,
  normalizeInn,
} from '../src/domain/sourceDocuments/resolve-contractor.js';

/**
 * Чистые функции автоподстановки подрядчика — без БД.
 *
 * Главное, что здесь защищается: контрольная сумма ИНН. На боевых данных LLM
 * переставляла цифры на сканах (7736255088 и 7736255608 вместо 7736255508), и
 * без этой проверки резолвер полагался бы только на то, что мусорный ИНН
 * «наверное, не найдётся в справочнике». Проверка делает отказ гарантированным,
 * а не вероятным — документ останется «Черновиком», и это правильный исход.
 */

describe('isValidInnChecksum', () => {
  it('принимает боевые 10-значные ИНН', () => {
    expect(isValidInnChecksum('7736255508')).toBe(true); // ООО «СУ-10»
    expect(isValidInnChecksum('7725494913')).toBe(true); // ООО «ФСК Инжиниринг»
    expect(isValidInnChecksum('7730626555')).toBe(true); // ООО «Европроект Групп»
  });

  it('отбраковывает ИНН с переставленными цифрами — оба реальных случая с прода', () => {
    expect(isValidInnChecksum('7736255088')).toBe(false);
    expect(isValidInnChecksum('7736255608')).toBe(false);
  });

  it('проверяет обе контрольные цифры 12-значного ИНН', () => {
    expect(isValidInnChecksum('370606654100')).toBe(true); // ИП из справочника
    // Портим последнюю цифру — вторая контрольная не сходится.
    expect(isValidInnChecksum('370606654101')).toBe(false);
    // Портим предпоследнюю — не сходится первая.
    expect(isValidInnChecksum('370606654200')).toBe(false);
  });
});

describe('normalizeInn', () => {
  it('вычищает разделители и пробелы', () => {
    expect(normalizeInn(' 7736255508 ')).toBe('7736255508');
    expect(normalizeInn('ИНН 7736255508')).toBe('7736255508');
    expect(normalizeInn('77-36-25-55-08')).toBe('7736255508');
  });

  it('отвергает всё, что не 10 и не 12 цифр', () => {
    expect(normalizeInn('773625550')).toBeNull();
    expect(normalizeInn('77362555081')).toBeNull();
    expect(normalizeInn('')).toBeNull();
    expect(normalizeInn(null)).toBeNull();
    expect(normalizeInn(undefined)).toBeNull();
  });

  it('отвергает ИНН с неверной контрольной суммой', () => {
    expect(normalizeInn('7736255088')).toBeNull();
    expect(normalizeInn('1234567890')).toBeNull();
  });
});

describe('manualRecipientSource', () => {
  const inbound = (over: Partial<Parameters<typeof manualRecipientSource>[0]> = {}) =>
    manualRecipientSource({
      direction: 'inbound',
      contractorId: null,
      recipientMolId: null,
      ...over,
    });

  it('получатель задан человеком → manual', () => {
    expect(inbound({ contractorId: 'c-1' })).toBe('manual');
    expect(inbound({ recipientMolId: 'm-1' })).toBe('manual');
  });

  it('получателя нет → null, документ считается нетронутым', () => {
    expect(inbound()).toBeNull();
  });

  it('outbound не помечается никогда: там contractor_id — отправитель', () => {
    expect(manualRecipientSource({ direction: 'outbound', contractorId: 'c-1', recipientMolId: null })).toBeNull();
    expect(
      manualRecipientSource({ direction: 'outbound', contractorId: null, recipientMolId: 'm-1' }),
    ).toBeNull();
  });
});
