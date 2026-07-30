/**
 * Эталонный снимок детерминированной классификации по всему корпусу
 * [docs/debug-upd/](../../../docs/debug-upd/).
 *
 * Существующий `document-router.test.ts` проверяет шесть показательных файлов
 * поимённо. Здесь фиксируется решение `classifyFile` для КАЖДОГО файла корпуса
 * — чтобы правка распознавания показывала в диффе полный список того, что
 * поехало, а не только специально выбранные случаи.
 *
 * LLM не участвует: `classifyFile` детерминирован (расширение + проба
 * текстового слоя), поэтому снимок воспроизводим и годится для CI.
 *
 * Расхождение — не всегда ошибка: если поведение изменено осознанно, снимок
 * обновляется `npx vitest -u` и разница читается в code review.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyFile } from '../src/domain/edo/document-router.js';

const CORPUS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/debug-upd',
);

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

describe('эталон классификации корпуса docs/debug-upd', () => {
  it('решение по каждому файлу совпадает с зафиксированным', async () => {
    const entries = await readdir(CORPUS, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && MIME_BY_EXT[path.extname(e.name).toLowerCase()])
      .map((e) => e.name)
      // Порядок фиксирован, иначе снимок «дрожит» между машинами.
      .sort((a, b) => a.localeCompare(b, 'en'));

    expect(files.length).toBeGreaterThan(40);

    const snapshot: Record<string, unknown> = {};
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      const buffer = await readFile(path.join(CORPUS, name));
      const c = await classifyFile(buffer, MIME_BY_EXT[ext]!, name);
      snapshot[name] = {
        detectedKind: c.detectedKind,
        needsVision: c.needsVision,
        parserUsed: c.parserUsed,
        confidence: c.confidence,
        // Сигналы — часть наблюдаемого решения: по ним читается, ПОЧЕМУ файл
        // отнесён к типу.
        signals: c.signals,
        ...(c.updInvoiceCount === undefined ? {} : { updInvoiceCount: c.updInvoiceCount }),
      };
    }

    await expect(snapshot).toMatchFileSnapshot('./fixtures/debug-upd-classification.snap.json');
  }, 300_000);
});
