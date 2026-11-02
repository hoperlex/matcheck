/**
 * Отбор договоров и ДС по типу и имени файла.
 *
 * Имена — настоящие, из переписи ящика СУ-10 (август–октябрь 2026). Главное,
 * что здесь закреплено: КС-2/акты/счета «по ДС» не выдаются за ДС, а
 * самостоятельные спецификации и прочие соглашения уходят на просмотр, а не
 * в выгрузку.
 */
import { describe, expect, it } from 'vitest';
import { classifyDocument, classifyName, extractContractRef, normalizeName } from '../src/domain/edo/contracts/classify.js';

const cat = (name: string) => classifyName(name).category;

describe('отбор по имени файла', () => {
  it('договоры', () => {
    expect(cat('Договор поставки_ ALIA (ул.Летная)_нерудка_ООО СУ-10_Карьер Парадиз.docx')).toBe('contract');
    expect(cat('СУ-10 ООО Договор №576-ПФ 2026 от 03.04.2026 г. - ПрофКонд.doc')).toBe('contract');
    expect(cat('Договор поставки _ INJOY_ООО СУ-10 _ООО БТД_30.09.2026 для ЭДО.PDF')).toBe('contract');
    // «ДП» — договор поставки; «дог» слитно с номером.
    expect(cat('ДП_СУ10_БАВ БЕтон_01.07.2026.docx')).toBe('contract');
    expect(cat('Букрин_дог0108-2026-ГО-СКЛ_редакция 2026_СКЛ.docx')).toBe('contract');
  });

  it('опечатка «допсоглашенние» — всё равно ДС', () => {
    expect(cat('4835 допсоглашенние.pdf')).toBe('supplementary');
  });

  it('бухгалтерская выгрузка со словом «Договоры» — исключена', () => {
    expect(cat('Анализ субконто Контрагенты, Договоры за 3 квартал 2026 г.pdf')).toBe('excluded');
  });

  it('ДС — в начале имени и внутри', () => {
    expect(cat('ДС1 к дог 072-04-08-25.pdf')).toBe('supplementary');
    expect(cat('дс6.docx')).toBe('supplementary');
    expect(cat('Дополнительное соглашение № 1.docx.pdf')).toBe('supplementary');
    expect(cat('ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № БН на предоставление доступа к Сервису «Личный кабинет СКУД».pdf')).toBe(
      'supplementary',
    );
    expect(cat('ДС (на НДС) к Дог. 01-03-24-М-СБ2.2.pdf')).toBe('supplementary');
    expect(cat('ДС №1_к Спец. №1_к Дог.№СУ-СОБ6.2_26-38 _изм 21.09.2026.pdf')).toBe('supplementary');
    expect(cat('Допсоглашение 3 к договору 15.pdf')).toBe('supplementary');
  });

  it('КС, акты, счета и претензии «по ДС» — исключены, а не ДС', () => {
    expect(cat('Форма КС-2_ДС №9.xlsx')).toBe('excluded');
    expect(cat('КС_3_№3_от_31_08_2026_период_01_08_2026_31_08_2026_ДС№1_14_3 (2).pdf')).toBe('excluded');
    expect(cat('Альянс_ЗИЛ18,19,27_подз_ДС4_КС2_№3_от_27.07.2026.pdf')).toBe('excluded');
    expect(cat('ДС №8 КС-2 для акта выполненных работ №1 .xlsx')).toBe('excluded');
    expect(cat('КС3№7ДС5.xlsx')).toBe('excluded');
    expect(cat('Акт ДС5.docx')).toBe('excluded');
    expect(cat('Счет ДС 1 к Дог 17-12-25 Бюро БВ.pdf')).toBe('excluded');
    expect(cat('Счет-договор № 382 от 11.09.2026 (4) (1).pdf')).toBe('excluded');
    expect(cat('ЗИЛ Счет-договор Синдикат RVI.pdf')).toBe('excluded');
    expect(cat('КС3 основной договор ИюЛь 2026 .pdf')).toBe('excluded');
    expect(cat('_Акт возврата оборудования СУ-10 Договор №04_08-1042  (1).pdf')).toBe('excluded');
    expect(cat('Исх. № 10.09-26СП от 08.09.2026 г. - Претензия о неисполнении Договора.pdf')).toBe('excluded');
    expect(cat('КС2 №2 от 03.06.2026 к дог. СУ1-10 5122025 общая.pdf')).toBe('excluded');
  });

  it('самостоятельные спецификации и приложения — на просмотр', () => {
    expect(classifyName('Спецификация №12 от 06.10.2026 к Договору  02.03.2026-3-ПР-ДМ к ДС№2.xlsx')).toMatchObject({
      category: 'spec',
      selection: 'review',
    });
    expect(cat('Приложение № 2 к договору № 4728 от 22,09,2026.pdf')).toBe('spec');
    expect(cat('СПФ № 1 от 01.07.2026 г. к Договору поставки № СУ-АЛ_90-18.pdf')).toBe('spec');
    expect(cat('Спецификация №1 от 14.09.2026 к Договору 02032026-4СУ-ДМ-4 по ДС 1.pdf')).toBe('spec');
    expect(cat('Прил №1 Спец.1 к ДС№1 к Дог.№СУ-СОБ6.2_26-38_ИЗМ. 21.09..pdf')).toBe('spec');
    expect(cat('Приложение №1 к ДС №1.1.pdf')).toBe('spec');
  });

  it('протоколы разногласий и прочие соглашения — на просмотр', () => {
    expect(classifyName('Протокол разногласий к договору 12.pdf')).toMatchObject({ category: 'protocol', selection: 'review' });
    expect(classifyName('СУ-10 (МСМ) Соглашение ЭПД с Покупателем.docx')).toMatchObject({
      category: 'agreement',
      selection: 'review',
    });
    expect(cat('Альков Соглашение от 13.08.2026.docx')).toBe('agreement');
    expect(cat('ПСР к ДП №СУ-АЛ_26-10 (3).docx')).toBe('protocol');
    expect(cat('Протоколо разногласий к договору_кровельные люки.docx')).toBe('protocol');
  });

  it('спецификация к «ДП» или «дог 551» — спецификация, а не договор', () => {
    expect(cat('Спецификация 2_ООО_СУ_10_дог 551 от 04.12.2025.doc')).toBe('spec');
    expect(cat('Спецификация №2_ООО_СУ_10_шаблон_к_3_х_стороннему_ДП.docx')).toBe('spec');
  });

  it('НДС, ДСП и прочее — не распознаны', () => {
    expect(cat('Плита ДСП 16мм.pdf')).toBe('unrecognized');
    expect(cat('Расчет НДС.xlsx')).toBe('unrecognized');
    expect(cat('Контакты.docx')).toBe('unrecognized');
    expect(cat('Счёт на оплату 15.pdf')).toBe('unrecognized');
    expect(classifyName(null)).toMatchObject({ category: 'unrecognized', reason: 'нет имени файла' });
  });

  it('«контракт», «актуальный», «расчёт» не задевают исключения', () => {
    expect(cat('Договор актуальная редакция.docx')).toBe('contract');
    expect(cat('Договор контакты сторон.docx')).toBe('contract');
    expect(cat('Договор сметный расчёт.pdf')).toBe('contract');
  });
});

describe('отбор по типу Диадока', () => {
  it('типизированные договор и ДС берутся при любом имени', () => {
    expect(classifyDocument('Contract', 'scan001.pdf')).toMatchObject({ category: 'contract', selection: 'auto' });
    expect(classifyDocument('SupplementaryAgreement', null)).toMatchObject({ category: 'supplementary', selection: 'auto' });
  });

  it('у неформализованного решает имя', () => {
    expect(classifyDocument('Nonformalized', 'Акт сверки по договору.pdf').category).toBe('excluded');
  });
});

describe('номер договора из имени', () => {
  it('берёт номер после «к договору / к дог / Дог.№»', () => {
    expect(extractContractRef('ДС1 к дог 072-04-08-25.pdf')).toBe('072-04-08-25');
    expect(extractContractRef('Приложение № 2 к договору № 4728 от 22,09,2026.pdf')).toBe('4728');
    expect(extractContractRef('ДС №1_к Спец. №1_к Дог.№СУ-СОБ6.2_26-38 _изм 21.09.2026.pdf')).toBe('СУ-СОБ6.2_26-38');
    expect(extractContractRef('СПФ № 1 от 01.07.2026 г. к Договору поставки № СУ-АЛ_90-18.pdf')).toBe('СУ-АЛ_90-18');
  });

  it('без «№» — только номер с цифры или с заглавного кода', () => {
    expect(extractContractRef('Договор_поставки_СУ-2-АЛ-Р-Э018-25 ДАМИР-А.docx')).toBe('СУ-2-АЛ-Р-Э018-25');
    expect(extractContractRef('Договор поставки _ Изотерм_2-ой этап_City Bay.docx')).toBeNull();
  });

  it('токен без цифры номером не считается', () => {
    expect(extractContractRef('Договор поставки _корп. 14 _ PRIMAVERA.docx')).toBeNull();
    expect(extractContractRef('дс6.docx')).toBeNull();
  });
});

describe('нормализация имени', () => {
  it('регистр, ё, подчёркивания, дефисы и расширение', () => {
    expect(normalizeName('КС_3_Счёт-Фактура.PDF')).toBe('кс 3 счет фактура');
  });
});
