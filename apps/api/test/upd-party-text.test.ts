/**
 * Юнит на общий разбор строк-сторон (upd-party-text.ts).
 *
 * Функция переехала сюда из upd-xlsx.parser.ts телом бит-в-бит и теперь
 * обслуживает оба локальных парсера. Тест фиксирует её контракт отдельно от
 * форм документов — чтобы правка в одном парсере не «починила» его за счёт
 * другого.
 */
import { describe, it, expect } from 'vitest';
import { matchParty, nameBeforeAddress } from '../src/domain/edo/upd-party-text.js';
import { consigneeOwnIdentity } from '../src/domain/sourceDocuments/party-directory-guard.js';

const CONSIGNEE = /^\s*Грузополучатель(?:\s+и\s+его\s+адрес)?:?\s*/;
const TERMINATOR = /\(4\)|Покупатель:|ИНН|Валюта:/;

describe('matchParty', () => {
  it('подпись не найдена → null', () => {
    expect(matchParty('Продавец ООО "Ромашка" (2)', CONSIGNEE, TERMINATOR)).toBeNull();
  });

  it('после подписи пусто → null, а не сама подпись', () => {
    expect(matchParty('Грузополучатель и его адрес:', CONSIGNEE, TERMINATOR)).toBeNull();
    expect(matchParty('Грузополучатель', CONSIGNEE, TERMINATOR)).toBeNull();
  });

  it('срезает хвостовой тег графы', () => {
    expect(matchParty('Грузополучатель: ООО "СУ-10" (4)', CONSIGNEE, TERMINATOR)).toBe(
      'ООО "СУ-10"',
    );
  });

  it('обрезает значение по терминатору', () => {
    expect(
      matchParty('Грузополучатель: ООО "СУ-10" Покупатель: ООО "Василёк"', CONSIGNEE, TERMINATOR),
    ).toBe('ООО "СУ-10"');
    expect(matchParty('Грузополучатель: ООО "СУ-10" ИНН 7736255508', CONSIGNEE, TERMINATOR)).toBe(
      'ООО "СУ-10"',
    );
  });

  it('двоеточие необязательно', () => {
    expect(matchParty('Грузополучатель и его адрес ООО "СУ-10" (4)', CONSIGNEE, TERMINATOR)).toBe(
      'ООО "СУ-10"',
    );
  });

  it('тег с буквой (2б) тоже срезается', () => {
    expect(matchParty('Продавец: ООО "Ромашка" (2б)', /^\s*Продавец:?\s*/, /\(2\)|ИНН/)).toBe(
      'ООО "Ромашка"',
    );
  });

  it('адрес остаётся в значении — резать его задача вызывающего', () => {
    // nameBeforeAddress живёт в парсере: у XLSX и PDF правило одно, но
    // применяется после matchParty, и смешивать их нельзя.
    expect(
      matchParty('Грузополучатель: ООО "СУ-10", Москва, ул. Вавилова, 69 (4)', CONSIGNEE, TERMINATOR),
    ).toBe('ООО "СУ-10", Москва, ул. Вавилова, 69');
  });
});

describe('nameBeforeAddress', () => {
  it('отрезает адрес после первой запятой', () => {
    expect(nameBeforeAddress('ООО "СУ-10", 127018, Город Москва, ул Полковая, дом 3')).toBe(
      'ООО "СУ-10"',
    );
  });

  it('строка без запятых не меняется', () => {
    expect(nameBeforeAddress('ООО «АЛЬЯНС»')).toBe('ООО «АЛЬЯНС»');
  });

  it.each([
    // Главный случай, ради которого функция стала quote-aware: наивное
    // split(',')[0] — а именно так резали оба текстовых парсера — отрезало бы
    // половину названия и «Альфа, Бета» превратилось бы в «Альфа».
    ['ООО "Альфа, Бета", 127018, Москва', 'ООО "Альфа, Бета"'],
    ['ООО «Гамма, Дельта», Москва, ул. Тверская', 'ООО «Гамма, Дельта»'],
    ['ЗАО "Три, два, один"', 'ЗАО "Три, два, один"'],
  ])('%s → %s (запятая внутри кавычек не граница)', (input, expected) => {
    expect(nameBeforeAddress(input)).toBe(expected);
  });

  it('пустое значение и пустой остаток → null', () => {
    expect(nameBeforeAddress(null)).toBeNull();
    expect(nameBeforeAddress(undefined)).toBeNull();
    expect(nameBeforeAddress('   ')).toBeNull();
    expect(nameBeforeAddress(', 127018, Москва')).toBeNull();
  });

  it('лишние пробелы по краям срезаются', () => {
    expect(nameBeforeAddress('  ООО "СУ-10"  ,  Москва  ')).toBe('ООО "СУ-10"');
  });
});

/**
 * Порядок «сначала проверка реквизитов, потом обрезка адреса».
 *
 * Соблазнительно обрезать имя первым — тогда сравнение сторон работало бы на
 * чистых названиях. Но это молча меняет политику реквизитов: у документа, где
 * модель вернула имя с адресом И ИНН покупателя, имена после обрезки совпали
 * бы, и выдуманный ИНН сохранился бы как «свой» — хотя в графе 4 реквизитов
 * не печатают вовсе.
 */
describe('порядок: consigneeOwnIdentity → nameBeforeAddress', () => {
  const RECIPIENT = { inn: '7736255508', kpp: '774550001', name: 'ООО "СУ-10"' };

  it('имя с адресом + ИНН покупателя: реквизиты отброшены, имя очищено', () => {
    const consignee = {
      inn: '7736255508',
      kpp: '774550001',
      name: 'ООО "СУ-10", 127018, Город Москва, ул Полковая, дом 3',
    };

    // Так это работает в воркере: сначала гард на исходном имени…
    const identity = consigneeOwnIdentity(consignee, RECIPIENT);
    expect(identity).toEqual({ inn: null, kpp: null });

    // …и только потом обрезка для записи в consignee_name_raw.
    expect(nameBeforeAddress(consignee.name)).toBe('ООО "СУ-10"');
  });

  it('обратный порядок сохранил бы выдуманный ИНН — так делать нельзя', () => {
    // Тот же документ, но имя обрезано ДО сравнения: стороны совпадают, и
    // реквизиты, которых в графе 4 нет, признаются законными.
    const cleaned = { inn: '7736255508', kpp: '774550001', name: 'ООО "СУ-10"' };
    expect(consigneeOwnIdentity(cleaned, RECIPIENT).inn).toBe('7736255508');
  });

  it('анти-регресс «он же»: имя без адреса, реквизиты сохраняются', () => {
    const consignee = { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' };
    expect(consigneeOwnIdentity(consignee, RECIPIENT)).toEqual({
      inn: '7736255508',
      kpp: '774550001',
    });
    expect(nameBeforeAddress(consignee.name)).toBe('ООО «СУ-10»');
  });
});
