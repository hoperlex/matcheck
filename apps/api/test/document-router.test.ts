import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { classifyFile } from '../src/domain/edo/document-router.js';
import { makeTextPdf, makeTextPdfPages } from './helpers/make-pdf.js';

/**
 * Детерминированный классификатор единого входа — офлайн, без LLM.
 * Замораживает маршрутизацию на реальных debug-файлах: Excel→УПД,
 * текстовый multi-UPD→bundle, одиночный УПД→parseUpdPdf, ТН→накладные,
 * скан/фото→needsVision (доклассификация vision на Этапе 4).
 */

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd-debug');
const load = (f: string) => readFileSync(join(dir, f));

describe('document-router classifyFile — детерминированная маршрутизация', () => {
  it('Excel (.xls) → УПД, structural, без vision', async () => {
    const c = await classifyFile(load('upd-1877.xls'), 'application/vnd.ms-excel', 'upd-1877.xls');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('parseUpdXlsx');
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('текстовый multi-UPD (зиларт) → УПД, tryParseTextUpdBundle, ≥2 счёт-фактур', async () => {
    const c = await classifyFile(load('zilart.pdf'), 'application/pdf', 'zilart.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('tryParseTextUpdBundle');
    expect(c.updInvoiceCount).toBe(4);
  });

  it('одиночный текстовый УПД (1221312) → parseUpdPdf, 1 счёт-фактура', async () => {
    const c = await classifyFile(
      load('single-1221312.pdf'),
      'application/pdf',
      'single-1221312.pdf',
    );
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdPdf');
    expect(c.updInvoiceCount).toBe(1);
  });

  it('транспортная накладная (ТН-PDF) → transport_waybill', async () => {
    const c = await classifyFile(load('tn-0006281148.pdf'), 'application/pdf', 'tn-0006281148.pdf');
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('parseWaybillBatch');
  });

  it('ТОРГ-12 со словом «Грузоотправитель» → УПД-путь', async () => {
    const pdf = makeTextPdf([
      'ТОВАРНАЯ НАКЛАДНАЯ № 7144 от 17 августа 2026 г. Унифицированная форма ТОРГ-12.',
      'Грузоотправитель: ООО «Поставщик», ИНН 7700000000.',
      'Грузополучатель: ООО «Стройка», ИНН 7711111111.',
      'Плательщик: ООО «Стройка». Основание: договор поставки № 15.',
      'Наименование товара, единица измерения, количество, цена, сумма.',
      'Цемент М500, мешок, 100, 500 руб., 50 000 руб.',
      'Всего по накладной: 50 000 руб., в том числе НДС 8 333,33 руб.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'torg-12.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdPdf');
  });

  it('ТН без ссылки на 2116, но с нумерованными разделами остаётся накладной', async () => {
    const pdf = makeTextPdf([
      'Транспортная накладная № 123 от 17 августа 2026 г.',
      '1. Грузоотправитель ООО «Поставщик», адрес и телефон организации.',
      '2. Грузополучатель ООО «Стройка», адрес места доставки груза.',
      '3. Груз: цемент М500, сто мешков, масса груза пять тонн.',
      '4. Сопроводительные документы на груз: паспорт качества № 77.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'tn-sections.pdf');
    expect(c.detectedKind).toBe('transport_waybill');
  });

  it('бланк ТН со ссылкой на счёт-фактуру не уходит в УПД-парсер', async () => {
    const pdf = makeTextPdf([
      'Транспортная накладная (форма) № 10426036352 от 07.10.2026.',
      '1. Грузоотправитель ООО «РОКВУЛ», адрес и телефон организации.',
      '2. Грузополучатель ООО «СУ-10», адрес места доставки груза.',
      '3. Груз: строительные материалы, 13 поддонов.',
      '4. Сопроводительные документы на груз: счёт-фактура прилагается.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'ТН № 10426036352.pdf');
    expect(c).toMatchObject({
      detectedKind: 'transport_waybill',
      parserUsed: 'parseWaybillBatch',
      signals: ['text:tn', 'text:upd-reference'],
    });
  });

  it('УПД с приложенной ТН остаётся в УПД-пути', async () => {
    const pdf = makeTextPdf([
      'Универсальный передаточный документ. Счёт-фактура № 55 от 07.10.2026.',
      'Поставщик ООО «РОКВУЛ», покупатель ООО «СУ-10».',
      'Наименование товара, количество, цена, сумма и НДС.',
      'Транспортная накладная № 55 от 07.10.2026 прилагается.',
      '1. Грузоотправитель ООО «РОКВУЛ». 2. Грузополучатель ООО «СУ-10».',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'upd-with-tn.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.updInvoiceCount).toBe(1);
  });

  it('УПД без номера с бланком ТН в конце первой страницы остаётся УПД', async () => {
    const pdf = makeTextPdf([
      'Универсальный передаточный документ. Счёт-фактура без указанного номера.',
      ...Array.from({ length: 18 }, (_, i) =>
        `Строка УПД ${i + 1}: товар, количество, цена, сумма, ставка и сумма НДС.`,
      ),
      'Транспортная накладная (форма) прилагается.',
      '1. Грузоотправитель ООО «РОКВУЛ».',
      '2. Грузополучатель ООО «СУ-10».',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'upd-with-tn-on-first-page.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.updInvoiceCount).toBe(0);
  });

  it('ТН первой страницей и УПД без номера дальше — файл остаётся в УПД-пути', async () => {
    // Номер у УПД не прочитался, поэтому одного «номеров нет» мало: страница
    // УПД начинается с его шапки, и весь файл в накладные уходить не должен —
    // иначе позиции УПД пропали бы из разбора.
    const pdf = makeTextPdfPages([
      [
        'Транспортная накладная (форма) № 10426036352 от 07.10.2026.',
        '1. Грузоотправитель ООО «РОКВУЛ».',
        '2. Грузополучатель ООО «СУ-10».',
        '3. Груз: материалы, 13 поддонов.',
        '4. Сопроводительные документы на груз: счёт-фактура прилагается.',
      ],
      [
        'Универсальный передаточный документ. Счёт-фактура без номера.',
        'Поставщик ООО «РОКВУЛ», покупатель ООО «СУ-10».',
        'Товар, количество, цена, сумма.',
      ],
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'tn-then-upd.pdf');
    expect(c.detectedKind).toBe('upd');
    expect(c.updInvoiceCount).toBe(0);
  });

  it('страница УПД с бланком ТН после шапки не считается бланком ТН', async () => {
    // На второй странице есть и заголовок, и разделы ТН, но первой стоит шапка
    // УПД: это УПД с приложенной накладной, а не ещё один экземпляр ТН.
    const pdf = makeTextPdfPages([
      [
        'Транспортная накладная (форма) № 10426036352.',
        '1. Грузоотправитель ООО «РОКВУЛ».',
        '2. Грузополучатель ООО «СУ-10».',
        '4. Сопроводительные документы: счёт-фактура прилагается.',
      ],
      [
        'Универсальный передаточный документ. Счёт-фактура без номера.',
        'Товар, количество, цена, сумма.',
        'Транспортная накладная прилагается.',
        '1. Грузоотправитель ООО «РОКВУЛ».',
        '2. Грузополучатель ООО «СУ-10».',
      ],
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'tn-then-upd-with-tn.pdf');
    expect(c.detectedKind).toBe('upd');
  });

  it('ТН в двух экземплярах со ссылкой на УПД в каждом — накладная', async () => {
    const copy = (n: number) => [
      `Транспортная накладная (форма) № 10426036352. Экземпляр № ${n}.`,
      '1. Грузоотправитель ООО «РОКВУЛ».',
      '2. Грузополучатель ООО «СУ-10».',
      '4. Сопроводительные документы: универсальный передаточный документ (УПД) №2770/07.',
    ];
    const pdf = makeTextPdfPages([copy(1), copy(2)]);
    const c = await classifyFile(pdf, 'application/pdf', 'tn-two-copies.pdf');
    expect(c).toMatchObject({
      detectedKind: 'transport_waybill',
      parserUsed: 'parseWaybillBatch',
      signals: ['text:tn', 'text:upd-reference'],
    });
  });

  it('одно упоминание ТН и слово «Грузоотправитель» не перехватывают документ', async () => {
    const pdf = makeTextPdf([
      'Договор поставки строительных материалов и приложение к договору.',
      'По заявке может быть оформлена транспортная накладная перевозчиком.',
      'Грузоотправитель обязан передать покупателю паспорта качества продукции.',
      'Стороны согласовали сроки, адрес доставки, порядок оплаты и ответственность.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'contract.pdf');
    expect(c.detectedKind).not.toBe('transport_waybill');
  });

  it('скан без текста (scanlite3) → needsVision (доклассификация Этап 4)', async () => {
    const c = await classifyFile(load('scanlite3.pdf'), 'application/pdf', 'scanlite3.pdf');
    expect(c.needsVision).toBe(true);
    expect(c.signals.some((s) => s.startsWith('pdf:scan'))).toBe(true);
  });

  it('фото (jpg) → needsVision', async () => {
    const c = await classifyFile(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', 'photo.jpg');
    expect(c.needsVision).toBe(true);
    expect(c.detectedKind).toBe('unknown');
  });
});

describe('document-router — сопроводительные документы и Excel', () => {
  const CERT_HEADER = 'Сертификат соответствия № РОСС RU.НА37.Н12345';

  it('текстовый сертификат → supplementary, без vision', async () => {
    const pdf = makeTextPdf([
      CERT_HEADER,
      'Орган по сертификации продукции, аккредитованный в установленном порядке.',
      'Продукция: смеси сухие строительные напольные. Изготовитель ООО «Ромашка».',
      'Соответствует требованиям технического регламента и национальных стандартов.',
      'Срок действия сертификата: с 01.02.2026 по 01.02.2029 включительно.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'cert.pdf');
    expect(c.detectedKind).toBe('supplementary');
    expect(c.needsVision).toBe(false);
  });

  it('КОРОТКИЙ сертификат (текста меньше порога) → supplementary, а не vision', async () => {
    // Текстовый слой сертификата часто состоит из пары строк заголовка. Без
    // отдельной ветки такой файл ушёл бы в vision — то есть в лишний вызов
    // модели ради файла, который распознавать не нужно.
    const pdf = makeTextPdf([CERT_HEADER]);
    const c = await classifyFile(pdf, 'application/pdf', 'cert-short.pdf');
    expect(c.detectedKind).toBe('supplementary');
    expect(c.needsVision).toBe(false);
  });

  it('УПД с упоминанием сертификата остаётся upd', async () => {
    const pdf = makeTextPdf([
      'Счёт-фактура № 1877 от 05.02.2026',
      'Продавец: ООО «Ромашка». Покупатель: ООО «Стройка».',
      'К поставке приложен сертификат соответствия на всю партию продукции.',
      'Всего к оплате: 123 456,78 руб., в том числе НДС 20 576,13 руб.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'upd.pdf');
    expect(c.detectedKind).toBe('upd');
  });

  // Боевой случай: 26-02261022358 от 05.11.2026 («Деловые Линии») становился
  // «УПД, распознано частично» с поставщиком-экспедитором. Теперь расписка
  // уходит в накладные: там её разбирает код и заводит «Накладную» для планшета.
  const RECEIPT_FRONT = [
    'Экспедиторская расписка ЭЭР № 26-00002654287',
    'Лицевая сторона (стр. 1 из 2)',
    '№26-02261022358 от 05.11.2026 г.',
    'Отправитель ЗАО "ПО "СПЕЦАВТОМАТИКА" ИНН/КПП: 2227005952/-',
    'Получатель ООО "ФОРТЭКС" ИНН/КПП: 7736332544/-',
    'Количество мест 6, кг 534, м3 2,18. Наименование груза: Сборный груз',
    'Экспедитор ООО "Деловые Линии"',
  ];

  it('экспедиторская расписка → накладные, без vision', async () => {
    const pdf = makeTextPdfPages([
      RECEIPT_FRONT,
      [
        'Экспедиторская расписка ЭЭР № 26-00002654287',
        'Оборотная сторона (стр. 2 из 2)',
        'Обязанности отправителя: сверка сопроводительных документов на груз.',
      ],
    ]);
    const c = await classifyFile(pdf, 'application/pdf', '26-02261022358 Накладная.pdf');
    expect(c).toMatchObject({
      detectedKind: 'transport_waybill',
      needsVision: false,
      parserUsed: 'parseWaybillBatch',
      signals: ['text:forwarding-receipt'],
    });
  });

  it('расписка с сертификатом на обороте остаётся распиской', async () => {
    const pdf = makeTextPdfPages([
      RECEIPT_FRONT,
      ['Отправитель прилагает сертификат соответствия на груз.'],
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'receipt.pdf');
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.signals).toEqual(['text:forwarding-receipt']);
  });

  it('УПД со ссылкой на экспедиторскую расписку в шапке остаётся upd', async () => {
    const pdf = makeTextPdf([
      'Экспедиторская расписка № 26-00011583553 к счёту-фактуре',
      'Счёт-фактура № 26-00011583553 от 18.10.2026',
      'Продавец: ООО "Деловые Линии". Покупатель: ООО "Стройка".',
      'Услуга по организации доставки (экспедированию) груза, 1 услуга.',
      'Всего к оплате: 13 090,00 руб., в том числе НДС 2 181,67 руб.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'upd-dellin.pdf');
    expect(c.detectedKind).toBe('upd');
  });

  it('ТН с экспедиторской распиской в сопроводительных остаётся накладной', async () => {
    const pdf = makeTextPdf([
      'Транспортная накладная № 15 от 05.11.2026',
      'Приложение № 4 к постановлению Правительства РФ № 2116',
      '1. Грузоотправитель ООО "Ромашка" ИНН 7700000000',
      '2. Грузополучатель ООО "Стройка" ИНН 7711111111',
      '4. Сопроводительные документы: экспедиторская расписка № 26-1',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'tn.pdf');
    expect(c.detectedKind).toBe('transport_waybill');
  });

  it('упоминание расписки в глубине текста не делает файл распиской', async () => {
    const pdf = makeTextPdf([
      'Договор поставки строительных материалов № 15 от 01.10.2026 г.',
      'Поставщик обязуется передать покупателю материалы по спецификации.',
      'Стороны согласовали сроки, адрес доставки и порядок оплаты товара.',
      'Покупатель обязуется принять материалы и оплатить их в срок.',
      'Доставка выполняется транспортной компанией за счёт поставщика.',
      'Передача груза перевозчику подтверждается экспедиторской распиской.',
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'contract.pdf');
    expect(c.detectedKind).toBe('unknown');
    expect(c.signals).toEqual(['text:ambiguous']);
  });

  it('расписка второй страницей после чужого листа — не расписка', async () => {
    const pdf = makeTextPdfPages([
      [
        'Спецификация к договору поставки № 15 от 01.10.2026 г.',
        'Наименование, количество, цена и срок поставки материалов.',
        'Профиль монтажный, 10 шт. Кабель силовой, 200 м. Щит, 2 шт.',
      ],
      RECEIPT_FRONT,
    ]);
    const c = await classifyFile(pdf, 'application/pdf', 'spec-and-receipt.pdf');
    expect(c.detectedKind).toBe('unknown');
  });

  it('XLSX без реквизитов УПД → unknown (не создаём пустой документ)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Спецификация');
    ws.addRow(['Спецификация к договору поставки']);
    ws.addRow(['Наименование', 'Кол-во']);
    ws.addRow(['Профиль монтажный', 10]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const c = await classifyFile(
      buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'spec.xlsx',
    );
    // Тип по-прежнему не подтверждён — пустой УПД из спецификации не заводим.
    // needsVision поднят: приговор такой книге выносит модель по картинке, а не
    // регулярка под шаблоны 1С (см. EXCEL_VISION_ROUTING). Без флага ветка
    // unknown в worker отработает как раньше — заглушка «не распознано».
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
    expect(c.signals).toContain('excel:not-upd');
  });

  it('нечитаемая книга → unknown: сохраняем файл, а не заводим пустой УПД', async () => {
    const c = await classifyFile(Buffer.from('not a workbook'), '', 'broken.xlsx');
    expect(c.detectedKind).toBe('unknown');
  });
});
