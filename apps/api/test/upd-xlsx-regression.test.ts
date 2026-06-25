import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseUpdXlsx } from '../src/domain/edo/upd-xlsx.parser.js';

/**
 * Регрессионный тест на ВСЕ рабочие xlsx-шаблоны.
 *
 * Цель — заморозить бизнес-критичные поля output'а parseUpdXlsx для
 * шаблонов, которые сейчас распознаются успешно. Любая правка парсера
 * (например, расширение marker-row detector в шаге 1) ОБЯЗАНА оставлять
 * эти assertions зелёными — иначе мы починили один шаблон ценой другого.
 *
 * Какие поля проверяем (по соглашению с пользователем):
 *   - docNumber, docDate
 *   - supplier.{inn,kpp,name}
 *   - recipient.{inn,kpp,name}
 *   - totalSum, vatSum (шапочный итог)
 *   - items[].{nameRaw, qty, unit, price, vatRate, vatSum, sum}
 *
 * НЕ проверяем (плавающие/вычисляемые/могут улучшаться):
 *   - confidence
 *   - itemsCount (как доп.поле от LLM, не критично для бизнеса)
 *   - items[].{volumeM3, massKg, volumeConfidence, groupName}
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(...rel: string[]): Buffer {
  return readFileSync(join(fixturesDir, ...rel));
}

describe('parseUpdXlsx — регрессия рабочих xlsx-шаблонов', () => {
  it('1С/Элевел upd-elevel-0041581 (новая форма 1137)', async () => {
    const r = await parseUpdXlsx(load('upd-xlsx', 'upd-elevel-0041581.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041581');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier).toEqual({
      inn: '5001112612',
      kpp: '772801001',
      name: 'Акционерное общество "Элевел Инженер"',
    });
    expect(r.recipient).toEqual({
      inn: '7736255508',
      kpp: '774550001',
      name: 'ООО "СУ-10"',
    });
    expect(r.totalSum).toBe(51362.78);
    expect(r.vatSum).toBe(9262.14);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      nameRaw:
        'Напольный люк на 6 постов (45х45) горизонтально, с крышкой из нержавеющей стали в уровень пола, с коробкой, IP40 300023',
      qty: 2,
      unit: 'шт',
      price: 21050.32,
      vatRate: 22,
      vatSum: 9262.14,
      sum: 51362.78,
    });
  });

  it('1С/Элевел upd-elevel-0041610 (2 позиции, vatRate 22%)', async () => {
    const r = await parseUpdXlsx(load('upd-xlsx', 'upd-elevel-0041610.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041610');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier?.inn).toBe('5001112612');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.totalSum).toBe(5663.18);
    expect(r.vatSum).toBe(1021.23);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      qty: 4,
      unit: 'шт',
      price: 432.89,
      vatRate: 22,
      vatSum: 380.94,
      sum: 2112.48,
    });
    expect(r.items[0].nameRaw).toContain('SPL Розетка RJ 45 Mosaic');
    expect(r.items[1]).toMatchObject({
      qty: 10,
      unit: 'шт',
      price: 291.04,
      vatRate: 22,
      vatSum: 640.29,
      sum: 3550.7,
    });
    expect(r.items[1].nameRaw).toContain('Розетка электрическая');
  });

  it('1С 2021 upd-asfb-10045 (старая форма, vatRate 20%, 3 позиции)', async () => {
    const r = await parseUpdXlsx(load('upd-xlsx', 'upd-asfb-10045.xlsx'));
    expect(r.docNumber).toBe('10045');
    expect(r.docDate).toBe('2023-04-10');
    expect(r.supplier?.inn).toBe('7704400689');
    expect(r.supplier?.kpp).toBe('770401001');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.totalSum).toBe(524370);
    expect(r.vatSum).toBe(87395);
    expect(r.items).toHaveLength(3);
    // Все позиции — vatRate=20 (документ 2023 года, до повышения).
    for (const item of r.items) {
      expect(item.vatRate).toBe(20);
      expect(item.unit).toBe('м3');
    }
    expect(r.items[0]).toMatchObject({
      qty: 49,
      price: 5416.67,
      sum: 318500,
      vatSum: 53083.33,
    });
    expect(r.items[1]).toMatchObject({
      qty: 26,
      price: 5204.17,
      sum: 162370,
      vatSum: 27061.67,
    });
    expect(r.items[2]).toMatchObject({
      qty: 75,
      price: 483.33,
      sum: 43500,
      vatSum: 7250,
    });
  });

  it('ТК-02815 (старый .xls/BIFF, 1С шаблон, теряет «1а»/«2а» после SheetJS — relaxed-pass)', async () => {
    // Через тот же путь, что и worker.ts: SheetJS BIFF→OOXML → parseUpdXlsx.
    const { convertXlsToXlsxBuffer } = await import(
      '../src/domain/edo/xls-to-xlsx.js'
    );
    const xlsxBuf = convertXlsToXlsxBuffer(load('upd-debug', 'tk-02815.xls'));
    const r = await parseUpdXlsx(xlsxBuf);

    expect(r.docNumber).toBe('ТК-02815');
    expect(r.docDate).toBe('2026-06-18');
    expect(r.supplier).toEqual({
      inn: '7714333304',
      kpp: '770501001',
      name: 'Общество с ограниченной ответственностью "ТПК Промаэротехника"',
    });
    expect(r.recipient).toEqual({
      inn: '7736255508',
      kpp: '774550001',
      name: 'ООО "СУ-10"',
    });
    expect(r.totalSum).toBe(32556);
    expect(r.vatSum).toBe(5870.75);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      nameRaw: 'Клапан верхний PatAIR-FKLv-11,2-2',
      qty: 2,
      unit: 'шт',
      price: 13342.63,
      vatRate: 22,
      vatSum: 5870.75,
      sum: 32556,
    });
  });

  it('1С/Элевел из docs/debug-upd (полная регрессия — vatRate 22%, 2 позиции)', async () => {
    // Эта фикстура — копия документа, ради которого пользователь и пожаловался
    // в первую итерацию ("этот формат не распознаётся"). На самом деле уже
    // распознаётся, и assertions ниже это закрепляют: любая попытка усилить
    // детектор marker-row в parseItemsAndTotals НЕ должна сломать этот кейс.
    const r = await parseUpdXlsx(load('upd-debug', 'eii-0041610.xlsx'));
    expect(r.docNumber).toBe('ЭИ00-0041610');
    expect(r.docDate).toBe('2026-05-29');
    expect(r.supplier).toEqual({
      inn: '5001112612',
      kpp: '772801001',
      name: 'Акционерное общество "Элевел Инженер"',
    });
    expect(r.recipient).toEqual({
      inn: '7736255508',
      kpp: '774550001',
      name: 'ООО "СУ-10"',
    });
    expect(r.totalSum).toBe(5663.18);
    expect(r.vatSum).toBe(1021.23);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].nameRaw).toContain('SPL Розетка RJ 45 Mosaic');
    expect(r.items[0]).toMatchObject({
      qty: 4,
      unit: 'шт',
      price: 432.89,
      vatRate: 22,
      vatSum: 380.94,
      sum: 2112.48,
    });
    expect(r.items[1].nameRaw).toContain('Розетка электрическая');
    expect(r.items[1]).toMatchObject({
      qty: 10,
      unit: 'шт',
      price: 291.04,
      vatRate: 22,
      vatSum: 640.29,
      sum: 3550.7,
    });
  });

  it('АЛЮТЕХ «Подтверждение отгрузки» T56532 (форма 2026: docNumber из «Подтверждение отгрузки №»)', async () => {
    // Раньше docNumber/docDate были null (заголовок не «Счёт-фактура №») →
    // «распознано частично», хотя позиции извлекались корректно.
    const r = await parseUpdXlsx(load('upd-debug', 'alutech-T56532.xlsx'));
    expect(r.docNumber).toBe('Т5653/2');
    expect(r.docDate).toBe('2026-06-22');
    expect(r.totalSum).toBe(4079.48);
    expect(r.vatSum).toBe(735.64);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      nameRaw: 'Подкладка рихтовочная 100x62x1',
      qty: 4,
      price: 835.96,
      vatRate: 22,
      vatSum: 735.64,
      sum: 4079.48,
    });
  });

  it('упд 1877.xls (форма 2026: фейк-строка номеров граф НЕ попадает в items)', async () => {
    const { convertXlsToXlsxBuffer } = await import('../src/domain/edo/xls-to-xlsx.js');
    const r = await parseUpdXlsx(convertXlsToXlsxBuffer(load('upd-debug', 'upd-1877.xls')));
    expect(r.docNumber).toBe('1877/18');
    expect(r.docDate).toBe('2026-06-22');
    // Ключевое: ровно 2 реальные позиции. Раньше под marker-row проходила
    // 3-я фейковая строка номеров граф (nameRaw="1", qty=3, sum=9) →
    // «суммы не сходятся».
    expect(r.items).toHaveLength(2);
    expect(r.items[0].nameRaw).toContain('Стеклопакет');
    expect(r.items[0]).toMatchObject({ vatRate: 22, vatSum: 554800.01, sum: 3076618.24 });
    expect(r.items[1].nameRaw).toContain('Доставка');
    expect(r.totalSum).toBe(3096618.24);
    expect(r.vatSum).toBe(558406.57);
  });

  it('ТК-02876.xls (новая .xls, 67 позиций — фиксы 2026 не ломают рабочий файл)', async () => {
    const { convertXlsToXlsxBuffer } = await import('../src/domain/edo/xls-to-xlsx.js');
    const r = await parseUpdXlsx(convertXlsToXlsxBuffer(load('upd-debug', 'tk-02876.xls')));
    expect(r.docNumber).toBe('ТК-02876');
    expect(r.docDate).toBe('2026-06-23');
    expect(r.items).toHaveLength(67);
    expect(r.totalSum).toBe(897131);
    expect(r.vatSum).toBe(161777.7);
    expect(r.items[0]).toMatchObject({
      nameRaw: 'Клапан обратный PatAIR-KP-KO-70-40',
      qty: 5,
      vatRate: 22,
      vatSum: 1370.49,
      sum: 7600,
    });
  });
});
