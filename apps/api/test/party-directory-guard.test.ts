/**
 * Юнит на фильтр записи в справочник контрагентов.
 *
 * Все «плохие» примеры взяты из боевого справочника: это реальные записи,
 * созданные автоматически из ошибок распознавания (перестановки цифр ИНН,
 * индекс из адреса вместо ИНН, обрывки подписей граф вместо названия).
 */
import { describe, it, expect } from 'vitest';
import {
  consigneeOwnIdentity,
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

describe('consigneeOwnIdentity — реквизиты, скопированные у покупателя', () => {
  const SU10 = { inn: '7736255508', kpp: '774550001', name: 'ООО "СУ-10"' };

  it('боевой случай 1736: другое имя при ИНН покупателя → реквизиты отброшены', () => {
    // Ровно то, что модель вернула на бою 14.08: имя грузополучателя своё,
    // а ИНН и КПП — компании из графы 6.
    const r = consigneeOwnIdentity(
      { inn: '7736255508', kpp: '774550001', name: 'ООО "АЛЬЯНС"' },
      SU10,
    );
    expect(r).toEqual({ inn: null, kpp: null });
  });

  it('«он же»: совпали и ИНН, и имя → реквизиты сохраняются', () => {
    // Законный случай: графа 4 отсылает к графе 6, повтор реквизитов верен.
    const r = consigneeOwnIdentity({ ...SU10 }, SU10);
    expect(r).toEqual({ inn: '7736255508', kpp: '774550001' });
  });

  it('разное написание одного юрлица не считается разными сторонами', () => {
    const r = consigneeOwnIdentity(
      { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
      { inn: '7736255508', kpp: '774550001', name: 'ООО  "СУ-10"' },
    );
    expect(r.inn).toBe('7736255508');
  });

  it('разные ИНН — сторона своя, ничего не трогаем', () => {
    const r = consigneeOwnIdentity(
      { inn: '7725494913', kpp: null, name: 'ООО "АЛЬЯНС"' },
      SU10,
    );
    expect(r).toEqual({ inn: '7725494913', kpp: null });
  });

  it('у грузополучателя нет ИНН — штатное состояние графы 4', () => {
    const r = consigneeOwnIdentity({ inn: null, kpp: null, name: 'ООО "АЛЬЯНС"' }, SU10);
    expect(r).toEqual({ inn: null, kpp: null });
  });

  it('ИНН совпал, но имя грузополучателя пусто → реквизиты отброшены', () => {
    // Пустое имя не может служить доказательством «он же»: сравнивать не с чем.
    const r = consigneeOwnIdentity({ inn: '7736255508', kpp: '774550001', name: null }, SU10);
    expect(r).toEqual({ inn: null, kpp: null });
  });

  it('ИНН совпал, но имя покупателя пусто → реквизиты отброшены', () => {
    const r = consigneeOwnIdentity(
      { inn: '7736255508', kpp: '774550001', name: 'ООО "АЛЬЯНС"' },
      { inn: '7736255508', kpp: '774550001', name: null },
    );
    expect(r).toEqual({ inn: null, kpp: null });
  });

  it('ИНН с пробелами считается тем же самым', () => {
    const r = consigneeOwnIdentity(
      { inn: '77 36 25 55 08', kpp: null, name: 'ООО "АЛЬЯНС"' },
      SU10,
    );
    expect(r).toEqual({ inn: null, kpp: null });
  });

  it('возвращаются ИСХОДНЫЕ значения, а не нормализованные', () => {
    // Нормализация нужна только для сравнения: в consignee_inn_raw должно
    // лечь то, что стояло в документе.
    const r = consigneeOwnIdentity(
      { inn: '77 25 49 49 13', kpp: '77-25-01-001', name: 'ООО "АЛЬЯНС"' },
      SU10,
    );
    expect(r).toEqual({ inn: '77 25 49 49 13', kpp: '77-25-01-001' });
  });

  it('покупателя нет вовсе — сравнивать не с чем, реквизиты остаются', () => {
    const r = consigneeOwnIdentity({ inn: '7736255508', kpp: null, name: 'ООО "СУ-10"' }, null);
    expect(r.inn).toBe('7736255508');
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
