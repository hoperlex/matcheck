/**
 * Юнит на фильтр записи в справочник контрагентов.
 *
 * Все «плохие» примеры взяты из боевого справочника: это реальные записи,
 * созданные автоматически из ошибок распознавания (перестановки цифр ИНН,
 * индекс из адреса вместо ИНН, обрывки подписей граф вместо названия).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePartyForDirectory,
  normalizePartyName,
} from '../src/domain/sourceDocuments/party-directory-guard.js';

const NAME = 'ООО "СУ-10"';

describe('normalizePartyForDirectory — ИНН', () => {
  it('валидный ИНН проходит и остаётся цифрами', () => {
    const r = normalizePartyForDirectory({ inn: '7736255508', kpp: '771501001', name: NAME });
    expect(r).toEqual({ inn: '7736255508', kpp: '771501001', name: NAME });
  });

  it('ИНН с пробелами и дефисами нормализуется к цифрам', () => {
    // Ключевой кейс дублей: «77 36 25 55 08» и «7736255508» — одна организация,
    // но точное сравнение их не связывало и заводило вторую запись.
    const r = normalizePartyForDirectory({ inn: '77 36 25 55 08', kpp: null, name: NAME });
    expect(r?.inn).toBe('7736255508');
  });

  it.each([
    ['7736255608', 'перестановка цифр — контрольная не сходится'],
    ['7736255088', 'вторая перестановка из боевого справочника'],
    ['127018', 'шесть цифр: это индекс из адреса, а не ИНН'],
    ['абвгдеёжзи', 'буквы'],
    ['', 'пусто'],
    [null, 'null'],
  ])('%s → null (%s)', (inn) => {
    expect(normalizePartyForDirectory({ inn, kpp: null, name: NAME })).toBeNull();
  });

  it('ИНН ИП (12 знаков) проходит', () => {
    expect(normalizePartyForDirectory({ inn: '500100732259', kpp: null, name: NAME })?.inn).toBe(
      '500100732259',
    );
  });
});

describe('normalizePartyForDirectory — имя', () => {
  it.each([
    ['(4)', 'номер графы вместо названия'],
    ['он же', 'отсылка к другой графе'],
    ['и его адрес:', 'подпись графы — ровно этот мусор лежит в проде'],
    ['Грузополучатель', 'подпись без значения'],
    ['—', 'прочерк'],
    ['ОО', 'короче трёх символов'],
    ['', 'пусто'],
  ])('%s → сторона не заводится (%s)', (name) => {
    expect(normalizePartyForDirectory({ inn: '7736255508', kpp: null, name })).toBeNull();
  });

  it('нормальное имя со схлопыванием пробелов', () => {
    expect(normalizePartyName('  ООО   "СУ-10"  ')).toBe('ООО "СУ-10"');
  });

  it('название, начинающееся со слова «Продавец» в составе, не отбрасывается по ошибке', () => {
    // Маркеры проверяются якорем ^ и целым словом — «Продавец-Сервис» это
    // название организации, а не подпись графы.
    expect(normalizePartyName('ООО "Продавец-Сервис"')).toBe('ООО "Продавец-Сервис"');
  });
});

describe('normalizePartyForDirectory — КПП', () => {
  it('девятизначный КПП сохраняется', () => {
    expect(
      normalizePartyForDirectory({ inn: '7736255508', kpp: '771501001', name: NAME })?.kpp,
    ).toBe('771501001');
  });

  it('мусорный КПП обнуляется, но сторону не блокирует', () => {
    // КПП участвует в ключе поиска: лучше пустой, чем неверный.
    const r = normalizePartyForDirectory({ inn: '7736255508', kpp: '77', name: NAME });
    expect(r).not.toBeNull();
    expect(r?.kpp).toBeNull();
  });
});
