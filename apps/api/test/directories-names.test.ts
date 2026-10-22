import { describe, expect, it } from 'vitest';
import {
  ALIASES_MAX,
  cleanInn,
  companyKey,
  editDistance,
  extractBracketInn,
  fixLegalFormTypo,
  formsCompatible,
  innDigits,
  legalForm,
  mergeAliases,
  personInitialsKey,
  styleContractorName,
  tokenKey,
} from '../src/domain/directories/names.js';

describe('directories/names — ключи сравнения', () => {
  it('форма собственности, кавычки, регистр и ё не влияют на companyKey', () => {
    expect(companyKey('ЭСКО ООО')).toBe(companyKey('ООО "Эско"'));
    expect(companyKey('ООО «ЛЕНИНЕРТ»')).toBe(companyKey('Ленинерт'));
    expect(companyKey('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ЭНВОЛ"')).toBe(
      companyKey('ООО "ЭНВОЛ"'),
    );
    expect(companyKey('Публичное акционерное общество «Ёлка»')).toBe(companyKey('АО "Елка"'));
  });

  it('опечатки формы «000», латинская «OOO» и «ОО» считаются формой', () => {
    expect(companyKey('000 Компания "Карат"')).toBe(companyKey('ООО "Компания Карат"'));
    expect(companyKey('OOO "ТД "АНМАКС"')).toBe(companyKey('ООО «ТД АНМАКС»'));
    expect(companyKey('ОО "Пластко"')).toBe(companyKey('ООО "Пластко"'));
  });

  it('пробелы вокруг дефиса и ИНН в скобках не мешают', () => {
    expect(companyKey('ООО «СУ - 90»')).toBe(companyKey('СУ-90 ООО'));
    expect(companyKey('АЛЬЯНС ООО (7716967786)')).toBe(companyKey('ООО «АЛЬЯНС»'));
  });

  it('tokenKey не зависит от порядка слов, companyKey — зависит', () => {
    expect(tokenKey('ГОРИЗОНТ СК ООО')).toBe(tokenKey('ООО «СК Горизонт»'));
    expect(companyKey('ГОРИЗОНТ СК ООО')).not.toBe(companyKey('ООО «СК Горизонт»'));
  });

  it('форма собственности распознаётся, ООО и АО несовместимы', () => {
    expect(legalForm('АО "МОНОЛИТСТРОЙ"')).toBe('АО');
    expect(legalForm('ПАО «Северсталь»')).toBe('АО');
    expect(legalForm('ООО "МОНОЛИТСТРОЙ"')).toBe('ООО');
    expect(legalForm('Гаджиев Хаял Меджнун Оглы ИП')).toBe('ИП');
    expect(legalForm('ОРИС ПРОМ')).toBeNull();
    expect(formsCompatible('АО "МОНОЛИТСТРОЙ"', 'ООО "МОНОЛИТСТРОЙ"')).toBe(false);
    expect(
      formsCompatible('Соловьева Наталия Владимировна', 'ИП Соловьева Наталия Владимировна'),
    ).toBe(true);
  });

  it('фамилия и инициалы', () => {
    expect(personInitialsKey('Порунов Артём Владимирович')).toBe(
      personInitialsKey('ИП Порунов А.В.'),
    );
    expect(personInitialsKey('Гаджиев Хаял Меджнун Оглы ИП')).toBe('ГАДЖИЕВ ХМ');
    expect(personInitialsKey('ИП Гречишников П. А.')).toBe('ГРЕЧИШНИКОВ ПА');
    expect(personInitialsKey('ВЕКТОР-СТРОЙ 26 ООО')).toBeNull();
  });
});

describe('directories/names — приведение к виду справочника', () => {
  it('fixLegalFormTypo правит только опечатку формы в начале', () => {
    expect(fixLegalFormTypo('000 Компания "Карат"')).toBe('ООО Компания "Карат"');
    expect(fixLegalFormTypo('OOO "ТД "АНМАКС"')).toBe('ООО "ТД "АНМАКС"');
    expect(fixLegalFormTypo(' ОО "Пластко" ')).toBe('ООО "Пластко"');
    expect(fixLegalFormTypo('ООО "Пластко"')).toBe('ООО "Пластко"');
    expect(fixLegalFormTypo('«ТД «ООО «МАРИО РИОЛИ» ')).toBe('«ТД «ООО «МАРИО РИОЛИ»');
    expect(fixLegalFormTypo('ООО «ОСТ»')).toBe('ООО «ОСТ»');
  });

  it('styleContractorName: форма из хвоста в начало, нестандартное без изменений', () => {
    expect(styleContractorName('ЭСКО ООО')).toBe('ООО "ЭСКО"');
    expect(styleContractorName('ТопРендж АО')).toBe('АО "ТопРендж"');
    expect(styleContractorName('Гаджиев Хаял Меджнун Оглы ИП')).toBe(
      'ИП Гаджиев Хаял Меджнун Оглы',
    );
    expect(styleContractorName('Гречишников П. А. ИП')).toBe('ИП Гречишников П. А.');
    expect(styleContractorName('ГРАДДОМСТРОЙ ООО ИК')).toBe('ГРАДДОМСТРОЙ ООО ИК');
    expect(styleContractorName('ОРИС ПРОМ  ')).toBe('ОРИС ПРОМ');
    expect(styleContractorName('Лязина Ангелина Ростиславовна')).toBe(
      'Лязина Ангелина Ростиславовна',
    );
    expect(styleContractorName('ИП Ганичев Ярослав Александрович')).toBe(
      'ИП Ганичев Ярослав Александрович',
    );
  });

  it('extractBracketInn: варианты записи и неверная контрольная сумма', () => {
    expect(extractBracketInn('АЛЬЯНС ООО (7716967786)')).toEqual({
      base: 'АЛЬЯНС ООО',
      inn: '7716967786',
      innRaw: '7716967786',
    });
    expect(extractBracketInn('МАСТЕР ООО (ИНН5017084167)').inn).toBe('5017084167');
    expect(extractBracketInn('ПЕРСПЕКТИВА ООО( ИНН9717168726)').inn).toBe('9717168726');
    expect(extractBracketInn('СУ - 90 ООО (9721225624) МС-90').base).toBe('СУ - 90 ООО МС-90');
    expect(extractBracketInn('ЮТАРА ООО (9704043738)')).toMatchObject({
      inn: null,
      innRaw: '9704043738',
    });
    expect(extractBracketInn('ЭСКО ООО')).toEqual({ base: 'ЭСКО ООО', inn: null, innRaw: null });
  });

  it('ИНН: цифры для сопоставления и очистка для новой строки', () => {
    expect(innDigits('ИНН 9704043737')).toBe('9704043737');
    expect(innDigits('7722466153,')).toBe('7722466153');
    expect(innDigits('50272996594')).toBeNull();
    expect(cleanInn('ИНН 9704043737')).toBe('9704043737');
    expect(cleanInn(' 9704043738 ')).toBe('9704043738');
  });
});

describe('directories/names — расстояние и алиасы', () => {
  it('Дамерау–Левенштейн: замена, вставка, удаление и перестановка стоят 1', () => {
    expect(editDistance('7842224734', '7842224734')).toBe(0);
    expect(editDistance('7842224734', '7842224735')).toBe(1);
    expect(editDistance('7842224734', '784224734')).toBe(1);
    expect(editDistance('5406354183', '5406534183')).toBe(1);
    expect(editDistance('7842224734', '7842247134')).toBe(2);
  });

  it('mergeAliases: без повторов и имени, существующие не трогаем', () => {
    const r = mergeAliases(
      ['ООО Ленинерт'],
      ['ооо  ленинерт', 'ООО "ЛЕНИНЕРТ"', 'Ленинерт'],
      'ООО "ЛЕНИНЕРТ"',
    );
    expect(r.aliases).toEqual(['ООО Ленинерт', 'Ленинерт']);
    expect(r.added).toEqual(['Ленинерт']);
    expect(r.dropped).toEqual([]);
  });

  it('mergeAliases: лимиты карточки — 20 штук и 500 символов', () => {
    const full = Array.from({ length: ALIASES_MAX }, (_, i) => `alias ${i}`);
    const r = mergeAliases(full, ['ещё один'], 'Имя');
    expect(r.aliases).toHaveLength(ALIASES_MAX);
    expect(r.dropped).toEqual(['ещё один']);
    expect(mergeAliases([], ['я'.repeat(501)], 'Имя').dropped).toHaveLength(1);
  });
});
