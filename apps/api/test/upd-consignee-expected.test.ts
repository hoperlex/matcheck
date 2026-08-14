/**
 * Эталон графы 4 (грузополучатель) против локального парсера.
 *
 * Пара к характеризационному baseline: тот сравнивает ВСЁ, кроме графы 4, с
 * зафиксированным поведением, а этот — только графу 4, и не с поведением, а с
 * тем, что напечатано в документах (фикстура upd-consignee-expected.json
 * выверена по независимому `pdftotext -layout`).
 *
 * Такое разделение — единственный способ одновременно утверждать «ничего
 * другого не изменилось» и «это поле теперь извлекается правильно»: общий
 * снимок пришлось бы обновлять после правки, и первое утверждение исчезло бы.
 *
 * Отдельно проверяется главное: парсер НИКОГДА не возвращает вместо значения
 * саму подпись графы. Именно так в прод попали три документа со значением
 * «и его адрес:» и один с «(4)».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseUpdText } from '../src/domain/edo/upd-pdf-local.parser.js';
import { corpusFiles, readPdfForParsers } from './helpers/debug-upd-corpus.js';

type Expectation = {
  printed: string | null;
  localParser: string | null;
  multiUpd?: boolean;
  why?: string;
};

const EXPECTED: Record<string, Expectation> = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/upd-consignee-expected.json'),
    'utf8',
  ),
).files;

/** Мусор, который парсер возвращал до правки вместо пустого значения. */
const LABEL_GARBAGE = /^(и\s+его\s+адрес|грузополучатель|\(\d+[а-я]?\))/iu;

describe('графа 4: локальный парсер против эталона документов', () => {
  it.each(Object.entries(EXPECTED))('%s', async (name, expected) => {
    const read = await readPdfForParsers(name);

    if (expected.multiUpd) {
      expect(read.kind).toBe('multi_upd');
      if (read.kind !== 'multi_upd') return;
      expect(read.segments.length).toBeGreaterThan(1);
      // Эталон утверждает про КАЖДЫЙ логический УПД пакета, а не про агрегат:
      // грузополучатель у одного из пятнадцати не должен выглядеть успехом.
      for (const seg of read.segments) {
        const parsed = parseUpdText(seg.text);
        expect(
          parsed.consignee?.name ?? null,
          `${name} → субдокумент ${seg.docNumber}`,
        ).toBe(expected.localParser);
      }
      return;
    }

    expect(read.kind).toBe('text_pdf');
    if (read.kind !== 'text_pdf') return;
    const parsed = parseUpdText(read.text);
    expect(parsed.consignee?.name ?? null).toBe(expected.localParser);
  });

  it('ни в одном документе корпуса парсер не возвращает подпись графы вместо значения', async () => {
    const files = await corpusFiles(['.pdf']);
    const garbage: string[] = [];

    for (const name of files) {
      const read = await readPdfForParsers(name);
      const texts =
        read.kind === 'multi_upd'
          ? read.segments.map((s) => ({ label: `${name}#${s.docNumber}`, text: s.text }))
          : read.kind === 'text_pdf'
            ? [{ label: name, text: read.text }]
            : [];

      for (const { label, text } of texts) {
        const value = parseUpdText(text).consignee?.name ?? null;
        if (value && LABEL_GARBAGE.test(value)) garbage.push(`${label}: ${value}`);
      }
    }

    expect(garbage).toEqual([]);
  }, 120_000);

  it('эталон не разошёлся с корпусом: все перечисленные файлы на месте', async () => {
    const files = new Set(await corpusFiles(['.pdf']));
    const missing = Object.keys(EXPECTED).filter((n) => !files.has(n));
    expect(missing).toEqual([]);
  });
});
