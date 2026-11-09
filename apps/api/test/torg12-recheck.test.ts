/**
 * Перепроверка ТОРГ-12: инварианты, ради которых она сделана узкой.
 *
 * Главное здесь не то, что лист РОКВУЛ находит своё место, а то, что ВСЁ
 * ОСТАЛЬНОЕ не меняется ни при каком ответе модели: файл, который сегодня
 * назван УПД или «прочим», не переспрашивается вовсе, а страница, уже
 * признанная УПД, не заменяется никогда. Поэтому большая часть тестов —
 * «ничего не произошло».
 */
import { describe, expect, it } from 'vitest';
import {
  fileNeedsRecheck,
  mergeFileVerdict,
  mergePageVerdicts,
  pagesNeedRecheck,
} from '../src/domain/edo/torg12-recheck.js';
import type { ImageDocKind } from '../src/domain/edo/vision-classifier.js';
import type { PageClassification, PageType } from '../src/domain/edo/upd-page-prefilter.js';

const v = (kind: ImageDocKind, confidence = 0.95) => ({ kind, confidence });

const pages = (...types: PageType[]): PageClassification[] =>
  types.map((type, i) => ({
    page: i + 1,
    type,
    use: type !== 'certificate' && type !== 'transport_waybill',
  }));

describe('файл: что переспрашивается', () => {
  it('принятые «М-15» и «ТН» — да', () => {
    expect(fileNeedsRecheck(v('m15'))).toBe(true);
    expect(fileNeedsRecheck(v('transport_waybill'))).toBe(true);
  });

  it('всё остальное — нет, включая ОС-2 и сертификаты', () => {
    for (const kind of ['upd', 'os2_transfer', 'supplementary', 'unknown'] as ImageDocKind[]) {
      expect(fileNeedsRecheck(v(kind))).toBe(false);
    }
  });

  it('неуверенный вердикт роутер не применяет — и перепроверка его не трогает', () => {
    expect(fileNeedsRecheck(v('m15', 0.59))).toBe(false);
    expect(fileNeedsRecheck(null)).toBe(false);
  });
});

describe('файл: итог', () => {
  it('лист РОКВУЛ: М-15 → УПД при уверенном ответе', () => {
    expect(mergeFileVerdict(v('m15'), v('upd', 0.9))).toEqual({
      verdict: v('upd', 0.9),
      changed: true,
    });
  });

  it('настоящая ТН остаётся ТН', () => {
    expect(mergeFileVerdict(v('transport_waybill'), v('transport_waybill'))).toEqual({
      verdict: v('transport_waybill'),
      changed: false,
    });
  });

  it('заменить можно ТОЛЬКО на УПД: М-15 → ТН или → «прочее» не применяется', () => {
    for (const kind of ['transport_waybill', 'os2_transfer', 'supplementary', 'unknown'] as const) {
      expect(mergeFileVerdict(v('m15'), v(kind)).changed).toBe(false);
    }
  });

  it('неуверенное «УПД» и отсутствие ответа ничего не меняют', () => {
    expect(mergeFileVerdict(v('m15'), v('upd', 0.5)).changed).toBe(false);
    expect(mergeFileVerdict(v('m15'), null)).toEqual({ verdict: v('m15'), changed: false });
  });

  it('файл, который не переспрашивается, не меняется даже при «ответе»', () => {
    // Защита от ошибки вызывающего: если второй вопрос всё же задан для УПД,
    // итог обязан остаться прежним.
    expect(mergeFileVerdict(v('upd'), v('m15'))).toEqual({ verdict: v('upd'), changed: false });
    expect(mergeFileVerdict(v('unknown', 0.9), v('upd'))).toEqual({
      verdict: v('unknown', 0.9),
      changed: false,
    });
  });
});

describe('страницы: что переспрашивается', () => {
  it('пакет без ТН / сертификата / М-15 не переспрашивается вовсе', () => {
    expect(pagesNeedRecheck(pages('upd_main', 'upd_continuation', 'other'))).toBe(false);
  });

  it('хотя бы одна подозрительная страница — переспрашивается', () => {
    expect(pagesNeedRecheck(pages('upd_main', 'transport_waybill'))).toBe(true);
    expect(pagesNeedRecheck(pages('certificate'))).toBe(true);
  });
});

describe('страницы: итог', () => {
  it('ТОРГ-12 РОКВУЛ: шапка из «ТН» и строки из «прочего» → один документ', () => {
    const merged = mergePageVerdicts(
      pages('transport_waybill', 'other'),
      pages('upd_main', 'upd_continuation'),
    );
    expect(merged.changedPages).toEqual([1, 2]);
    expect(merged.classification.map((p) => [p.type, p.use])).toEqual([
      ['upd_main', true],
      ['upd_continuation', true],
    ]);
  });

  it('лист со строками загружен первым: «сертификат» + «ТН» → продолжение + шапка', () => {
    const merged = mergePageVerdicts(
      pages('certificate', 'transport_waybill'),
      pages('upd_continuation', 'upd_main'),
    );
    expect(merged.changedPages).toEqual([1, 2]);
  });

  it('УПД + настоящая ТН: модель подтвердила ТН — ничего не меняется', () => {
    const base = pages('upd_main', 'transport_waybill');
    const merged = mergePageVerdicts(base, pages('upd_main', 'transport_waybill'));
    expect(merged).toEqual({ classification: base, changedPages: [] });
  });

  it('без найденной шапки ТОРГ-12 не меняется НИЧЕГО, даже «ТН» → продолжение', () => {
    // Модель на втором вопросе назвала ТН продолжением, но шапки среди
    // подозрительных страниц нет — это не ТОРГ-12, пакет остаётся как был.
    const base = pages('upd_main', 'transport_waybill', 'other');
    const merged = mergePageVerdicts(base, pages('upd_main', 'upd_continuation', 'upd_continuation'));
    expect(merged).toEqual({ classification: base, changedPages: [] });
  });

  it('страница, уже признанная УПД, не меняется никогда', () => {
    const merged = mergePageVerdicts(
      pages('upd_continuation', 'transport_waybill'),
      // Второй ответ перевернул всё — применяется только подозрительная страница.
      pages('upd_main', 'upd_main'),
    );
    expect(merged.changedPages).toEqual([2]);
    expect(merged.classification[0]!.type).toBe('upd_continuation');
  });

  it('«прочее» меняется только в пакете с найденной шапкой ТОРГ-12', () => {
    const base = pages('upd_main', 'other');
    expect(mergePageVerdicts(base, pages('upd_main', 'upd_continuation')).changedPages).toEqual([]);
  });

  it('подозрительная страница меняется только на УПД-типы', () => {
    const merged = mergePageVerdicts(
      pages('transport_waybill', 'certificate'),
      pages('upd_main', 'other'),
    );
    expect(merged.changedPages).toEqual([1]);
    expect(merged.classification[1]!.type).toBe('certificate');
  });

  it('нет ответа второго вызова — ничего не меняется', () => {
    const base = pages('transport_waybill', 'other');
    expect(mergePageVerdicts(base, null)).toEqual({ classification: base, changedPages: [] });
  });

  it('страница, пропущенная во втором ответе, остаётся как была', () => {
    const merged = mergePageVerdicts(pages('transport_waybill', 'other'), [
      { page: 1, type: 'upd_main', use: true },
    ]);
    expect(merged.changedPages).toEqual([1]);
    expect(merged.classification[1]!.type).toBe('other');
  });
});
