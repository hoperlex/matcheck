/**
 * Замок на сравнение с published_generation.
 *
 * История, ради которой файл существует. Отметка о публикации хранит НОМЕР
 * поколения, а проверяли её на `!== null`, то есть «пакет когда-либо
 * публиковался». Повторная отправка того же комплекта поднимает активное
 * поколение, published остаётся на прошлом номере — и работа нового поколения
 * молча объявлялась сделанной.
 *
 * Мест оказалось четыре, и чинились они по одному, потому что каждое проявлялось
 * по-своему:
 *   * гейт сборки — сборка не запускалась, файлы получали заглушки;
 *   * loadSegmentContext — задания сегментов отбрасывались как «неактуальные»,
 *     пакет навсегда оставался в processing;
 *   * откат сборки — пакет не закрывался и висел в processing;
 *   * tryFinalizeUpdAssembly — единственное, где сравнение изначально было
 *     верным.
 *
 * Пятое место обойдётся так же дорого, поэтому проверка текстовая: она ловит
 * возврат к `!== null` в любом из этих файлов, чего не сделает ни один
 * поведенческий тест — тот проверяет лишь тот путь, который сам же и задал.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const worker = readFileSync(join(srcDir, 'worker.ts'), 'utf-8');
const finalize = readFileSync(
  join(srcDir, 'domain', 'sourceDocuments', 'bundle-finalize.ts'),
  'utf-8',
);

/** Строки кода без комментариев: в них история дефекта описана словами. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));
}

describe('published_generation сравнивается с поколением, а не с null', () => {
  it('в worker.ts не осталось проверок «публиковался когда-либо»', () => {
    const offenders = codeLines(worker).filter(
      (line) => /published\w*\s*!==\s*null/i.test(line) || /published\w*\s*!=\s*null/i.test(line),
    );

    expect(offenders).toEqual([]);
  });

  it('гейт сборки и проверка актуальности сегмента сравнивают с номером поколения', () => {
    // Обе ветки обязаны спрашивать «опубликовано ЭТО поколение?», иначе
    // повторная загрузка комплекта снова застрянет.
    expect(worker).toContain('root.publishedGeneration === generation');
    expect(worker).toContain('root.published === job.generation');
  });

  it('откат сборки получает поколение и сравнивает с ним', () => {
    const offenders = codeLines(finalize).filter((line) =>
      /publishedGeneration\s*!==\s*null/i.test(line),
    );
    expect(offenders).toEqual([]);
    expect(finalize).toContain('bundle.publishedGeneration === opts.generation');
    // Вызывающий обязан передать поколение — без него сравнение вырождается в
    // прежнее «когда-либо публиковался».
    expect(worker).toMatch(/requireUnpublished:\s*true,[\s\S]{0,400}?\n\s*generation,/);
  });
});
