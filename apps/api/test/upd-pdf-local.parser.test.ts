import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseUpdText } from '../src/domain/edo/upd-pdf-local.parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upd');

function load(name: string): string {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  return raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

describe('parseUpdText — локальный парсер УПД-PDF', () => {
  it('УПД №961 (1С, 51 позиция) — извлекает все поля', () => {
    const r = parseUpdText(load('upd-961-1c.txt'));
    expect(r.docNumber).toBe('961');
    expect(r.docDate).toBe('2025-08-05');
    expect(r.supplier?.inn).toBe('7743429410');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.totalSum).toBeCloseTo(339277.8, 1);
    expect(r.vatSum).toBeCloseTo(56546.3, 1);
    expect(r.items).toHaveLength(51);
    expect(r.items[0].nameRaw).toBe('Воздуховод ш20/ш20 700x300 Оцин 1 L=1250');
    expect(r.items[0].qty).toBe(1);
    expect(r.items[0].unit).toBe('шт');
    expect(r.items[0].price).toBeCloseTo(1992.33, 2);
    // vatRate/vatSum в items не извлекаются — поля убраны из UpdPdfItemSchema
    // (см. миграцию 0016): бизнесу они в позициях не нужны.
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('УПД №2493 (iText, 1 позиция с длинным именем) — корректные числа', () => {
    const r = parseUpdText(load('upd-2493.txt'));
    expect(r.docNumber).toBe('249/3');
    expect(r.docDate).toBe('2026-05-05');
    expect(r.supplier?.inn).toBe('7743917287');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.totalSum).toBeCloseTo(555000, 0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].nameRaw).toContain('Светильник');
    expect(r.items[0].nameRaw).toContain('Selecta');
    expect(r.items[0].qty).toBe(222);
    expect(r.items[0].price).toBeCloseTo(2049.18, 2);
    expect(r.items[0].sum).toBeCloseTo(454918.03, 2);
    // vatRate/vatSum в items не извлекаются (см. миграцию 0016).
  });

  it('УПД №20121125720 (5 позиций, неоднозначные пробелы в числах) — partition по qty*price≈sum', () => {
    const r = parseUpdText(load('upd-20121125720.txt'));
    expect(r.docNumber).toBe('201/21125720');
    expect(r.docDate).toBe('2026-05-13');
    expect(r.items).toHaveLength(5);
    // последняя позиция была сломана при наивном greedy-разборе:
    // "180 134.02 24 122.95" → qty=180, price=134.02, sum=24122.95
    const last = r.items[4];
    expect(last.qty).toBe(180);
    expect(last.price).toBeCloseTo(134.02, 2);
    expect(last.sum).toBeCloseTo(24122.95, 2);
  });

  it('УПД №26051200033 (iText, 1 позиция, имя на 5 строк) — не съедает «SOLID 500» как новый item', () => {
    const r = parseUpdText(load('upd-26051200033.txt'));
    expect(r.docNumber).toBe('26051200033');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].nameRaw.startsWith('ТЕХНОНИКОЛЬ')).toBe(true);
    expect(r.items[0].nameRaw).toContain('SOLID 500');
    expect(r.items[0].qty).toBeCloseTo(72.576, 3);
    expect(r.items[0].unit).toBe('м3');
  });

  it('пустой текст → items=[], confidence=0', () => {
    const r = parseUpdText('Не УПД, просто текст. '.repeat(20));
    expect(r.items).toHaveLength(0);
    expect(r.confidence).toBe(0);
  });
});

describe('parseUpdText — грузополучатель (графа 4)', () => {
  // Графу 4 печатают вместе с адресом и БЕЗ ИНН, поэтому проверяем ровно две
  // вещи: имя отрезано от адреса и inn === null. Второе важнее: с непустым
  // ИНН воркер полез бы заводить контрагента, а связывать там нечего.
  it.each([
    ['upd-961-1c.txt', 'ООО "СУ-10"'],
    ['upd-2493.txt', 'ООО «СУ-10»'],
    ['upd-20121125720.txt', 'ООО "СТРОИТЕЛЬНОЕ УПРАВЛЕНИЕ - 10"'],
    ['upd-26051200033.txt', 'ООО "СУ-10"'],
  ])('%s → имя без адреса, ИНН пустой', (fixture, expected) => {
    const r = parseUpdText(load(fixture));
    expect(r.consignee?.name).toBe(expected);
    expect(r.consignee?.inn ?? null).toBeNull();
  });

  it('добавление графы 4 не сдвинуло продавца и покупателя', () => {
    // Анти-регресс: стороны, которые парсер извлекал и раньше, должны остаться
    // ровно теми же — иначе новая регулярка перехватила чужую строку.
    const r = parseUpdText(load('upd-961-1c.txt'));
    expect(r.supplier?.inn).toBe('7743429410');
    expect(r.recipient?.inn).toBe('7736255508');
    expect(r.items).toHaveLength(51);
  });

  it('«он же» в графе 4 означает покупателя', () => {
    const text = [
      'Счет-фактура № 5 от 10 июля 2026 г. (1)',
      'Продавец ООО "Ромашка" (2)',
      'ИНН/КПП 7743429410 / 771301001 (2б)',
      'Грузоотправитель и его адрес он же (3)',
      'Грузополучатель и его адрес он же (4)',
      'Покупатель ООО "Василёк" (6)',
      'ИНН/КПП 7736255508 / 774550001 (6б)',
    ].join('\n');
    const r = parseUpdText(text);
    expect(r.consignee?.name).toBe('ООО "Василёк"');
  });

  it('документ без графы 4 → consignee = null, а не пустой объект', () => {
    const text = [
      'Счет-фактура № 7 от 10 июля 2026 г. (1)',
      'Продавец ООО "Ромашка" (2)',
      'ИНН/КПП 7743429410 / 771301001 (2б)',
      'Покупатель ООО "Василёк" (6)',
      'ИНН/КПП 7736255508 / 774550001 (6б)',
    ].join('\n');
    const r = parseUpdText(text);
    expect(r.consignee ?? null).toBeNull();
  });
});

describe('parseUpdText — форматы подписи графы 4 (регресс «и его адрес:»)', () => {
  // Все четыре фикстуры выше — «счастливый» формат без двоеточия. В проде
  // встречается и формат С двоеточием, и на нём прежняя регулярка
  // /^Грузополучатель(?:\s+и\s+его\s+адрес)?\s+(.+?)(?:\s*\(4\))?$/
  // захватывала САМУ подпись: опциональная группа не могла замкнуться на \s+
  // перед двоеточием, движок её пропускал, и (.+?) забирал «и его адрес:».
  // Так в БД попали три документа со значением «и его адрес:» (УПД 345/346/347).
  function withConsigneeLine(line: string): string {
    return [
      'Счет-фактура № 11 от 10 июля 2026 г. (1)',
      'Продавец ООО "Ромашка" (2)',
      'ИНН/КПП 7743429410 / 771301001 (2б)',
      line,
      'Покупатель ООО "Василёк" (6)',
      'ИНН/КПП 7736255508 / 774550001 (6б)',
    ].join('\n');
  }

  it.each([
    // [строка документа, ожидаемое значение]
    ['Грузополучатель и его адрес: ООО "СУ-10" (4)', 'ООО "СУ-10"'],
    ['Грузополучатель и его адрес: ООО "СУ-10", Москва, ул. Вавилова, 69 (4)', 'ООО "СУ-10"'],
    ['Грузополучатель: ООО "СУ-10" (4)', 'ООО "СУ-10"'],
    ['Грузополучатель и его адрес ООО "СУ-10" (4)', 'ООО "СУ-10"'],
    [' Грузополучатель и его адрес: ООО "СУ-10" (4)', 'ООО "СУ-10"'],
  ])('%s → %s', (line, expected) => {
    expect(parseUpdText(withConsigneeLine(line)).consignee?.name).toBe(expected);
  });

  it.each([
    ['Грузополучатель и его адрес: (4)'],
    ['Грузополучатель и его адрес:'],
    ['Грузополучатель (4)'],
    ['Грузополучатель:'],
  ])('%s → consignee = null (подпись без значения)', (line) => {
    const r = parseUpdText(withConsigneeLine(line));
    // Именно null, а не сама подпись: пустая графа не должна выглядеть
    // заполненной — иначе в колонке портала стоит «и его адрес:».
    expect(r.consignee ?? null).toBeNull();
  });

  it('подпись с двоеточием не сдвинула соседние стороны', () => {
    const r = parseUpdText(withConsigneeLine('Грузополучатель и его адрес: ООО "СУ-10" (4)'));
    expect(r.supplier?.name).toBe('ООО "Ромашка"');
    expect(r.supplier?.inn).toBe('7743429410');
    expect(r.recipient?.name).toBe('ООО "Василёк"');
    expect(r.recipient?.inn).toBe('7736255508');
  });
});
