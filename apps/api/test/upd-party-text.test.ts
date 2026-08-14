/**
 * Юнит на общий разбор строк-сторон (upd-party-text.ts).
 *
 * Функция переехала сюда из upd-xlsx.parser.ts телом бит-в-бит и теперь
 * обслуживает оба локальных парсера. Тест фиксирует её контракт отдельно от
 * форм документов — чтобы правка в одном парсере не «починила» его за счёт
 * другого.
 */
import { describe, it, expect } from 'vitest';
import { matchParty } from '../src/domain/edo/upd-party-text.js';

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
