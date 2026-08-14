/**
 * Характеризационный baseline локальных (без LLM) парсеров по всему корпусу
 * [docs/debug-upd/](../../../docs/debug-upd/).
 *
 * Зачем. Задача «грузополучатель» правит регулярку графы 4 в
 * upd-pdf-local.parser.ts и выносит matchParty в общий модуль. Требование к
 * этой правке — «всё, что уже распознаётся, не меняется». Проверять это
 * глазами по четырём фикстурам нельзя: текстовый путь разбирает 25 файлов
 * корпуса, среди них пакеты из 4, 5 и 15 УПД.
 *
 * Конструкция снимка (важно, иначе тест противоречит сам себе):
 *
 *   1. Baseline снят на коде ДО правки и больше не пересобирается. Если
 *      vitest -u просит обновить — значит правка задела то, что задевать не
 *      должна, и обновлять надо не снимок.
 *   2. Грузополучателя в снимке НЕТ вовсе. Это единственное поле, которое
 *      правка обязана изменить, и его присутствие здесь заставляло бы
 *      обновлять baseline — то есть уничтожало бы саму гарантию. Графа 4
 *      проверяется отдельно: upd-pdf-local.parser.test.ts (форматы строки) и
 *      фикстура expected-consignee (что реально напечатано в документах).
 *   3. Multi-UPD снимается ПО СУБДОКУМЕНТАМ через segmentUpdText — той же
 *      функцией, которой пользуется прод. Один parseUpdText по всему PDF
 *      охарактеризовал бы пакет из 15 УПД одним номером и одной шапкой.
 *
 * LLM не участвует: parseUpdText и parseUpdXlsx детерминированы, прогон
 * бесплатный и годится для CI.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { parseUpdText } from '../src/domain/edo/upd-pdf-local.parser.js';
import { parseUpdXlsx } from '../src/domain/edo/upd-xlsx.parser.js';
import { convertXlsToXlsxBuffer } from '../src/domain/edo/xls-to-xlsx.js';
import { CORPUS_DIR, corpusFiles, readPdfForParsers } from './helpers/debug-upd-corpus.js';

type PartySnapshot = { inn: string | null; kpp: string | null; name: string | null } | null;

type ParsedSnapshot = {
  docNumber: string | null;
  docDate: string | null;
  totalSum: number | null;
  vatSum: number | null;
  itemsCount: number | null;
  confidence: number | null;
  supplier: PartySnapshot;
  recipient: PartySnapshot;
  itemsLength: number;
  items: Array<{
    nameRaw: string | null;
    qty: number | null;
    unit: string | null;
    price: number | null;
    sum: number | null;
    vatRate: number | null;
    vatSum: number | null;
  }>;
};

function party(p: UpdPdfParsed['supplier']): PartySnapshot {
  if (!p) return null;
  return { inn: p.inn ?? null, kpp: p.kpp ?? null, name: p.name ?? null };
}

/**
 * Снимок разбора. `consignee` СОЗНАТЕЛЬНО пропущен — см. правило 2 в шапке.
 */
function snapshotOf(parsed: UpdPdfParsed): ParsedSnapshot {
  return {
    docNumber: parsed.docNumber ?? null,
    docDate: parsed.docDate ?? null,
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    confidence: parsed.confidence ?? null,
    supplier: party(parsed.supplier),
    recipient: party(parsed.recipient),
    itemsLength: parsed.items.length,
    items: parsed.items.map((it) => ({
      nameRaw: it.nameRaw ?? null,
      qty: it.qty ?? null,
      unit: it.unit ?? null,
      price: it.price ?? null,
      sum: it.sum ?? null,
      vatRate: it.vatRate ?? null,
      vatSum: it.vatSum ?? null,
    })),
  };
}

describe('характеризационный baseline локальных парсеров (docs/debug-upd)', () => {
  it('разбор каждого файла совпадает с зафиксированным (кроме графы 4)', async () => {
    const files = await corpusFiles(['.pdf', '.xls', '.xlsx']);
    expect(files.length).toBeGreaterThan(30);

    const snapshot: Record<string, unknown> = {};

    for (const name of files) {
      const ext = path.extname(name).toLowerCase();

      if (ext === '.xls' || ext === '.xlsx') {
        const buffer = await readFile(path.join(CORPUS_DIR, name));
        try {
          const xlsx = ext === '.xls' ? convertXlsToXlsxBuffer(buffer) : buffer;
          snapshot[name] = { path: 'excel', parsed: snapshotOf(await parseUpdXlsx(xlsx)) };
        } catch (err) {
          snapshot[name] = { path: 'excel', error: (err as Error).constructor.name };
        }
        continue;
      }

      const read = await readPdfForParsers(name);
      switch (read.kind) {
        case 'error':
          snapshot[name] = { path: 'pdf', error: read.error };
          break;
        case 'no_text':
          // Скан/фото без текстового слоя: локальный парсер до него не доходит,
          // документ уходит в vision. Фиксируем сам факт, а не пустой разбор.
          snapshot[name] = { path: 'no_text', textLength: read.textLength };
          break;
        case 'multi_upd':
          // Пакет из нескольких УПД — снимаем каждый субдокумент отдельно, тем
          // же разбиением, что делает прод (tryParseTextUpdBundle).
          snapshot[name] = {
            path: 'multi_upd',
            segments: read.segments.map((seg) => ({
              segmentIndex: seg.segmentIndex,
              docNumber: seg.docNumber,
              pages: seg.pages,
              parsed: snapshotOf(parseUpdText(seg.text)),
            })),
          };
          break;
        case 'text_pdf':
          snapshot[name] = { path: 'text_pdf', parsed: snapshotOf(parseUpdText(read.text)) };
          break;
      }
    }

    await expect(snapshot).toMatchFileSnapshot(
      './fixtures/upd-text-parsers-characterization.snap.json',
    );
  }, 300_000);
});
