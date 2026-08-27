/**
 * Тот же маршрут, но на НАСТОЯЩЕЙ книге и без единого мока.
 *
 * Соседний document-router-excel-vision.test.ts подменяет parseUpdXlsx и
 * collectRowsViaSheetJS, то есть проверяет только условие ветки. Здесь книга
 * собирается по-настоящему и проходит через реальный структурный парсер:
 * это независимое подтверждение первой половины диагноза — бланк ТН не даёт
 * parseUpdXlsx ни одного поля шапки и ни одной позиции, отсюда 'excel:not-upd'.
 *
 * Книга синтетическая и обезличенная: боевого НИ26-002357.xlsx в репозитории
 * нет, а его собственный диагноз подтверждён продакшен-сигналом excel:not-upd
 * в bundle_import_items — тестом его доказывать не требуется.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { classifyFile } from '../src/domain/edo/document-router.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';

/**
 * Бланк ТН по форме 2116 — структура листа как у боевой книги.
 *
 * `bookType` вынесен в параметр, потому что тот же бланк приходит и в старом
 * формате: 1С у части поставщиков выгружает .xls (BIFF), и текст листа оттуда
 * читает уже не ExcelJS, а SheetJS-фоллбэк. Признак ТН обязан находиться в
 * обоих — иначе публичный приём .xls отдавал бы накладную в УПД-путь.
 */
function waybillWorkbook(bookType: 'xlsx' | 'xls' = 'xlsx'): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Приложение № 4 к Правилам перевозок грузов автомобильным транспортом'],
    ['(в ред. Постановления Правительства РФ от 30.11.2021 № 2116)'],
    ['Транспортная накладная'],
    ['Дата 21.08.2026', '№ ТрН0000001'],
    ['Экземпляр № 1'],
    ['1. Грузоотправитель', 'Обособленное подразделение ООО «Пример», ИНН 0000000000'],
    ['2. Грузополучатель', 'ООО «Получатель», ИНН 1111111111'],
    ['3. Груз', 'Оборудование, 2 (два) грузовых места'],
    ['4. Сопроводительные документы на груз (при наличии)'],
    ['Универсальный передаточный документ ПР-000001 от 21.08.2026'],
    ['5. Указания грузоотправителя по особым условиям перевозки'],
    ['6. Перевозчик', 'ИП Перевозчиков П.П., ИНН 222222222222'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Транспортная_накладная');
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

describe('document-router: настоящая книга с бланком ТН', () => {
  it('структурный парсер УПД не находит в ней ничего — сигнал excel:not-upd', async () => {
    const c = await classifyFile(waybillWorkbook(), XLSX_MIME, 'НИ00-000001.xlsx');
    expect(c.signals).toContain('excel:not-upd');
    // Без рубильника — ровно нынешнее поведение: заглушка под ручной разбор.
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
  });

  it('с рубильником уходит к промпту накладных', async () => {
    const c = await classifyFile(waybillWorkbook(), XLSX_MIME, 'НИ00-000001.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.parserUsed).toBe('parseWaybillBatch');
    expect(c.signals).toEqual(expect.arrayContaining(['excel:not-upd', 'form:tn']));
  });

  it('тот же бланк в старом .xls ведёт себя ровно так же', async () => {
    // Публичная форма принимает .xls с тех пор, как вход научился отличать
    // книгу от .doc по корневому потоку контейнера. Здесь проверяется вторая
    // половина обещания: принятый файл не только доезжает, но и маршрутизируется
    // как его .xlsx-близнец — ExcelJS на BIFF падает, и текст листа берёт
    // SheetJS-фоллбэк в collectRows.
    const c = await classifyFile(waybillWorkbook('xls'), XLS_MIME, 'НИ00-000001.xls', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.parserUsed).toBe('parseWaybillBatch');
    expect(c.signals).toEqual(expect.arrayContaining(['excel:not-upd', 'form:tn']));
  });
});
