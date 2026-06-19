import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { describe, it, expect } from 'vitest';
import { checkPdfTextQuality } from '../src/domain/edo/upd-pdf.parser.js';

/**
 * Регрессионные тесты на маршрутизацию PDF в worker'е:
 *
 *  - Чистый скан (pdf-parse даёт <200 символов) → PdfNoTextError
 *    → worker идёт в Vision-fallback.
 *  - PDF с OCR-мусором (есть текст >200 символов, но это кракозябры
 *    от сканера) → checkPdfTextQuality возвращает причину →
 *    PdfTextGarbageError → worker идёт в Vision.
 *  - Обычный текстовый PDF (sanity check: «УПД», «ИНН», «Всего») →
 *    checkPdfTextQuality возвращает null → text-LLM.
 *
 * Цель: ЗАМОРОЗИТЬ текущие классификации для проблемных файлов из
 * docs/debug-upd. Любая правка детектора, которая случайно поменяет
 * маршрут (особенно — отправит обычный документ в Vision вместо
 * text-LLM, или наоборот scan в text-LLM) — поломает эти тесты.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function extractText(file: string): Promise<string> {
  const buf = readFileSync(file);
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  let text = '';
  try {
    const r = await parser.getText();
    text = r.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

describe('PDF text routing — чистый скан vs OCR-мусор vs обычный текст', () => {
  it('scanlite3.pdf — чистый скан (<200 chars) → PdfNoTextError-маршрут', async () => {
    const text = await extractText(join(fixturesDir, 'upd-debug', 'scanlite3.pdf'));
    // Quartz PDFContext для чистых сканов даёт ~10-20 символов (хедер
    // «-- 1 of 1 --» и не более). Если станет >200 — что-то изменилось
    // в pdf-parse или сам файл; в обоих случаях нужно перепроверить
    // классификацию вручную.
    expect(text.length).toBeLessThan(200);
  });

  it('1697.pdf — мусорный OCR-слой (>200 chars) → PdfTextGarbageError-маршрут', async () => {
    const text = await extractText(join(fixturesDir, 'upd-debug', '1697.pdf'));
    // Условие №1: символов больше порога — попадаем в checkPdfTextQuality.
    expect(text.length).toBeGreaterThan(200);
    const reason = checkPdfTextQuality(text);
    // Условие №2: детектор обязан вернуть причину (мусор).
    // На текущем файле срабатывает на нулевом счётчике ключевых слов УПД,
    // т.к. Canon SC1011 OCR разбивает кириллицу в крякозябры без слова.
    expect(reason).not.toBeNull();
    // Фиксируем конкретную причину — это контракт детектора. Если эвристики
    // переписать так, что причина изменится — тест нужно явно обновить
    // (а не молча принять). Контракт: причина начинается с одного из
    // известных тегов.
    expect(reason).toMatch(
      /^(no_upd_keywords|strange_chars_ratio|avg_word_length)/,
    );
  });

  it('обычный текстовый набор УПД → checkPdfTextQuality === null (text-LLM)', () => {
    // Синтетический минимальный «нормальный» УПД-текст (не из файла —
    // pdf-parse у нас уже покрывает реальные кейсы выше). Проверяем что
    // детектор НЕ ложно-срабатывает на типовом наборе слов: счёт-фактура,
    // продавец, покупатель, ИНН, КПП, наименование, всего к оплате.
    const goodText =
      'Универсальный передаточный документ\n' +
      'Счёт-фактура № 12345 от 18.06.2026\n' +
      'Продавец: ООО «Поставщик», ИНН 7700000000 КПП 770001001\n' +
      'Покупатель: ООО «Покупатель», ИНН 7711111111 КПП 771101001\n' +
      'Грузоотправитель: тот же\n' +
      'Грузополучатель: тот же\n' +
      'Наименование товара / работ / услуг — количество — цена — стоимость\n' +
      'Клапан верхний — 2 шт — 13 342,63 — 26 685,25\n' +
      'Налоговая ставка: 22%\n' +
      'Всего к оплате: 32 556,00 руб.\n' +
      'Подпись руководителя организации.';
    expect(goodText.length).toBeGreaterThan(200);
    expect(checkPdfTextQuality(goodText)).toBeNull();
  });

  it('checkPdfTextQuality не ловит false-positive на коротких УПД с несколькими словами', () => {
    // Угловой случай: УПД с 2 ключевыми словами и обычной структурой —
    // не должен помечаться как garbage из-за того что текст короткий
    // или содержит много цифр. Защита от чрезмерно агрессивного
    // детектора, который мог бы выгонять нормальные документы в Vision.
    const shortGood =
      'Универсальный передаточный документ.\n' +
      'Счёт-фактура № 100 от 18.06.2026, передаточный документ.\n' +
      'Продавец: ООО Поставщик, ИНН 7700000000.\n' +
      'Наименование: товар. Количество: 1 шт. Цена: 100,00.\n' +
      'Всего к оплате: 100,00 руб. Налоговая ставка: 22%. КПП: 770001001.';
    expect(shortGood.length).toBeGreaterThan(200);
    expect(checkPdfTextQuality(shortGood)).toBeNull();
  });
});
