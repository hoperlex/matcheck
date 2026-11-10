/**
 * Версия промпта из файла (`upd-prompt-ab --new-file`).
 *
 * Черновик сверяется без записи в таблицу prompts, а в таблицу его потом
 * переносит миграция. Здесь важно, чтобы sha256 в отчёте сверки совпал с
 * будущей строкой таблицы (хвост файла срезается), чтобы id не был выдуманным
 * (иначе вызовы молча не попадут в llm_calls) и чтобы пустой файл не прошёл
 * за «версию».
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promptFromFile } from '../scripts/prompt-ab-lib.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('promptFromFile', () => {
  it('срезает хвостовые переводы строки и пробелы, начало и середину не трогает', () => {
    const p = promptFromFile('  Строка 1\n\nСтрока 2  \n\n', 'draft.txt');
    expect(p.content).toBe('  Строка 1\n\nСтрока 2');
  });

  it('id — null, имя помечено как файл', () => {
    const p = promptFromFile('текст', 'torg12-v1.txt');
    expect(p.id).toBeNull();
    expect(p.name).toBe('file:torg12-v1.txt');
  });

  it('пустой файл — ошибка, а не пустая версия', () => {
    expect(() => promptFromFile('\n \n', 'empty.txt')).toThrow(/пуст/);
  });
});

const draft = (file: string) =>
  promptFromFile(readFileSync(join(here, '../scripts/prompts', file), 'utf8'), file);

describe.each(['torg12-v1.txt', 'torg12-v2.txt'])('черновик %s', (file) => {
  const p = draft(file);

  it('требует qty: null — иначе правило ТОРГ-12 не посчитает количество', () => {
    // detectTorg12Qty пересчитывает только пустое qty (или совпавшее с массой
    // нетто): прочитанная графа 7 осталась бы количеством — 60 вместо 780.
    expect(p.content).toMatch(/qty — ВСЕГДА null/);
  });

  it('называет графы 7, 8 и 10 по полям правила', () => {
    expect(p.content).toMatch(/qtyPerPlace — графа 7/);
    expect(p.content).toMatch(/places — графа 8/);
    expect(p.content).toMatch(/massNetKg — графа 10/);
  });

  it('не зависит от того, виден ли код формы на снимке', () => {
    // v18 включала раздел ТОРГ-12 условием «если в шапке ОКУД 0330212» и на
    // коллажах и вторых листах его не применяла (прогон А 10.11: 0 из 13).
    expect(p.content).not.toMatch(/^Если в шапке/m);
  });
});

describe('черновик torg12-v2.txt — уточнения после прогона А 10.11', () => {
  const v1 = draft('torg12-v1.txt');
  const v2 = draft('torg12-v2.txt');

  it('строка шапки со срезанной подписью определяется по месту', () => {
    // ab64a7b9: подпись «Грузополучатель» срезана краем коллажа — у v1 пусто.
    expect(v2.content).toMatch(/подпись строки слева срезана/);
  });

  it('порядок граф масс: брутто, затем нетто, затем деньги', () => {
    expect(v2.content).toMatch(/сначала графа 9 \(брутто/);
  });

  it('v2 только дополняет v1: всё прежнее на месте', () => {
    for (const line of v1.content.split('\n').filter((l) => l.trim() !== '')) {
      expect(v2.content).toContain(line);
    }
  });
});
