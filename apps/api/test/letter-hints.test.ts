/**
 * Дата поставки из письма — необязательная подсказка.
 *
 * Главное свойство: сомнительное значение даёт `null` и НЕ блокирует письмо.
 * Пустая дата — штатное состояние (в самом УПД её нет), документ просто
 * попадает к инспектору в группу «остальные».
 */
import { describe, expect, it } from 'vitest';
import { parseDeliveryDateHint } from '../src/domain/mail/letter-hints.js';

describe('дата поставки из письма', () => {
  it('распознаёт ДД.ММ.ГГГГ', () => {
    expect(parseDeliveryDateHint('Дата поставки: 05.08.2026')).toBe('2026-08-05');
  });

  it('принимает / и - как разделители, а также ISO', () => {
    expect(parseDeliveryDateHint('Дата поставки: 05/08/2026')).toBe('2026-08-05');
    expect(parseDeliveryDateHint('Дата доставки - 5-8-2026')).toBe('2026-08-05');
    expect(parseDeliveryDateHint('Поставка: 2026-08-05')).toBe('2026-08-05');
  });

  it('день и месяц без ведущих нулей', () => {
    expect(parseDeliveryDateHint('Дата привоза: 5.8.2026')).toBe('2026-08-05');
  });

  it('без года — null: гадать про год нельзя', () => {
    expect(parseDeliveryDateHint('Дата поставки: 05.08')).toBeNull();
  });

  it('двузначный год — null', () => {
    expect(parseDeliveryDateHint('Дата поставки: 05.08.26')).toBeNull();
  });

  it('несуществующая дата — null', () => {
    expect(parseDeliveryDateHint('Дата поставки: 30.02.2026')).toBeNull();
    expect(parseDeliveryDateHint('Дата поставки: 45.13.2026')).toBeNull();
  });

  it('мусор вместо даты — null', () => {
    expect(parseDeliveryDateHint('Дата поставки: завтра утром')).toBeNull();
    expect(parseDeliveryDateHint('Дата поставки: ')).toBeNull();
  });

  it('две разные даты — null, выбирать наугад нельзя', () => {
    expect(
      parseDeliveryDateHint('Дата поставки: 05.08.2026\nДата доставки: 06.08.2026'),
    ).toBeNull();
  });

  it('одна и та же дата дважды — принимается', () => {
    expect(
      parseDeliveryDateHint('Дата поставки: 05.08.2026, повторно поставка: 05.08.2026'),
    ).toBe('2026-08-05');
  });

  it('дата документа датой поставки не считается', () => {
    // Она распознаётся из самого УПД; путать их нельзя.
    expect(parseDeliveryDateHint('Дата документа: 01.07.2026')).toBeNull();
    expect(parseDeliveryDateHint('УПД № 214 от 01.07.2026')).toBeNull();
  });

  it('письма без даты вообще', () => {
    expect(parseDeliveryDateHint('Объект: ЗИЛ33\nНаправляю документы')).toBeNull();
  });
});
