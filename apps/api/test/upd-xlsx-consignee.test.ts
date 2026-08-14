/**
 * Графа 4 (грузополучатель) в Excel-УПД.
 *
 * Excel — единственный формат, который разбирается БЕЗ модели: структурный
 * парсер читает ячейки, промпт в этом пути не участвует вовсе, и корпусная
 * сверка версий промпта его намеренно пропускает. Из-за этого поведение графы 4
 * здесь не проверялось ничем: существующие xlsx-тесты смотрят номер, суммы и
 * позиции, но про грузополучателя не говорят ни слова.
 *
 * Что здесь важно зафиксировать. Парсер жёстко ставит `inn: null, kpp: null`
 * (upd-xlsx.parser.ts) — и это правильно: в графе 4 формы 1137 реквизитов нет.
 * Именно на этом свойстве держится вся защита от подстановки чужого ИНН: если
 * Excel-путь однажды начнёт «дозаполнять» реквизиты из графы 6, документ молча
 * свяжется с чужой организацией — ровно то, что случилось на vision-пути с
 * промптом v9.
 *
 * Проверяются оба формата: .xlsx (OOXML) и .xls (BIFF, через SheetJS) — у них
 * разные ветки чтения ячеек.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseUpdXlsx } from '../src/domain/edo/upd-xlsx.parser.js';
import { convertXlsToXlsxBuffer } from '../src/domain/edo/xls-to-xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'upd-xlsx');
const corpus = join(here, '../../../docs/debug-upd');

async function parse(path: string, isXls: boolean) {
  const buf = readFileSync(path);
  return parseUpdXlsx(isXls ? convertXlsToXlsxBuffer(buf) : buf);
}

describe('Excel-УПД: грузополучатель', () => {
  it.each([
    ['upd-asfb-10045.xlsx', '10045', 3, 'ООО "СУ-10"'],
    ['upd-elevel-0041581.xlsx', 'ЭИ00-0041581', 1, 'ООО "СУ-10"'],
    ['upd-elevel-0041610.xlsx', 'ЭИ00-0041610', 2, 'ООО "СУ-10"'],
  ])('%s: имя из графы 4 есть, реквизитов нет', async (file, docNumber, items, consignee) => {
    const r = await parse(join(fixtures, file), false);

    // Шапка и позиции — чтобы тест ловил не только графу 4, но и её влияние на
    // соседние поля.
    expect(r.docNumber).toBe(docNumber);
    expect(r.items).toHaveLength(items);
    expect(r.totalSum).toBeGreaterThan(0);

    expect(r.consignee?.name).toBe(consignee);
    // Ключевое: реквизиты именно null, а не пустая строка и не значение из
    // графы 6. Пустая строка прошла бы `consignee.inn &&` в воркере так же, как
    // null, но в *_inn_raw легла бы мусором.
    expect(r.consignee?.inn ?? null).toBeNull();
    expect(r.consignee?.kpp ?? null).toBeNull();
  });

  it.each([
    ['упд 1877.xls', '1877/18', 2],
    ['УПД № ТК-02815 от 18 июня 2026 г..xls', 'ТК-02815', 1],
  ])('%s (.xls через SheetJS): та же гарантия', async (file, docNumber, items) => {
    const r = await parse(join(corpus, file), true);

    expect(r.docNumber).toBe(docNumber);
    expect(r.items).toHaveLength(items);
    expect(r.consignee?.name).toBeTruthy();
    expect(r.consignee?.inn ?? null).toBeNull();
    expect(r.consignee?.kpp ?? null).toBeNull();
  });

  it('грузополучатель, совпавший с покупателем, реквизиты покупателя НЕ получает', async () => {
    // В этих документах грузополучатель и покупатель — одна организация. Даже
    // тогда ИНН в графу 4 подставлять нельзя: там его не печатают, и различить
    // «он же» от ошибки распознавания потом будет нечем.
    const r = await parse(join(fixtures, 'upd-asfb-10045.xlsx'), false);
    expect(r.recipient?.inn).toBeTruthy();
    expect(r.consignee?.name).toBe(r.recipient?.name);
    expect(r.consignee?.inn ?? null).toBeNull();
  });
});
