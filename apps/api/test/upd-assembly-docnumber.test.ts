/**
 * Нарезка по номеру документа: боевой случай УТ-4308 и защита от лишних
 * разрезов.
 *
 * Что произошло на бою (пакет 62eac60f, файл «ИНСТРАКТ отгрузка 03.09.26.
 * 1 фура.pdf», 9 страниц). Классификатор разметил страницы чередованием
 * «шапка/оборот», и первая страница шестого документа — УТ-4308 — попала в
 * сегмент к УТ-4309. Парсер на сегмент возвращает ровно один документ, и
 * УТ-4308 (36 189,52 ₽) не появился нигде: ни строки, ни ошибки, ни
 * расхождения в валидации остальных документов.
 *
 * Второй набор проверок — про обратную опасность: лишний разрез рвёт
 * настоящий документ пополам, поэтому любое сомнение обязано оставлять
 * страницы вместе.
 */
import { describe, expect, it } from 'vitest';
import { planUpdSegments } from '../src/domain/edo/upd-assembly.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const page = (
  n: number,
  type: PageClassification['type'],
  docNumber?: string,
): PageClassification => ({
  page: n,
  type,
  use: type !== 'certificate' && type !== 'transport_waybill',
  ...(docNumber !== undefined ? { docNumber } : {}),
});

/** Боевая разметка «1 фура.pdf»: девять страниц, шесть документов. */
const REAL_CASE: PageClassification[] = [
  page(1, 'upd_main', 'УТ-4304'),
  page(2, 'upd_continuation', 'УТ-4304'),
  page(3, 'upd_main', 'УТ-4305'),
  page(4, 'upd_continuation', 'УТ-4305'),
  page(5, 'upd_main', 'УТ-4306'),
  page(6, 'upd_continuation', 'УТ-4306'),
  page(7, 'upd_main', 'УТ-4309'),
  // Вот она: шапка УТ-4308, прочитанная как оборот УТ-4309.
  page(8, 'upd_continuation', 'УТ-4308'),
  page(9, 'upd_main', 'УТ-4307'),
];

const plan = (cls: PageClassification[], splitByDocNumber: boolean, total = cls.length) =>
  planUpdSegments(cls, total, 5, { splitByDocNumber });

describe('нарезка по смене номера документа', () => {
  it('боевой пакет: 9 страниц дают 6 документов, УТ-4308 больше не съеден', () => {
    const p = plan(REAL_CASE, true);
    expect(p.confident).toBe(true);
    expect(p.segments).toHaveLength(6);
    expect(p.segments.map((s) => s.docNumber)).toEqual([
      'УТ-4304',
      'УТ-4305',
      'УТ-4306',
      'УТ-4309',
      'УТ-4308',
      'УТ-4307',
    ]);
    // Страница 8 открывает свой сегмент и больше не приклеена к УТ-4309.
    expect(p.segments[3]!.pages).toEqual([7]);
    expect(p.segments[4]!.pages).toEqual([8]);
  });

  it('тот же вход при выключенном правиле нарезается как сегодня', () => {
    const p = plan(REAL_CASE, false);
    expect(p.segments).toHaveLength(5);
    expect(p.segments[3]!.pages).toEqual([7, 8]);
  });

  it('вход без номеров даёт прежние 5 сегментов даже при включённом правиле', () => {
    const withoutNumbers = REAL_CASE.map((c) => page(c.page, c.type));
    expect(plan(withoutNumbers, true).segments).toHaveLength(5);
  });

  it('сегмент, открытый сменой номера, доверия к плану не отменяет', () => {
    const p = plan(REAL_CASE, true);
    const opened = p.segments[4]!;
    expect(opened.confidence).toBe('normal');
    expect(opened.reasons[0]).toBe('opened_by_doc_number_change');
    expect(p.confident).toBe(true);
  });

  it('чужой номер на странице «other» тоже открывает документ', () => {
    // Пакет 422a66f1: потерянный документ лежал на странице, которую
    // классификатор отнёс к «other», а не к продолжению.
    const cls = [
      page(1, 'upd_main', '0000-0082603'),
      page(2, 'other', '0000-0082604'),
      page(3, 'upd_main', '0000-0082605'),
    ];
    const p = plan(cls, true);
    expect(p.segments).toHaveLength(3);
    expect(p.segments[1]!.pages).toEqual([2]);
  });

  it('разрез + приклеенная чужая страница не роняют весь план', () => {
    const cls = [
      page(1, 'upd_main', 'УТ-1'),
      page(2, 'upd_continuation', 'УТ-2'),
      page(3, 'other'),
    ];
    const p = plan(cls, true);
    expect(p.segments).toHaveLength(2);
    expect(p.segments[1]!.pages).toEqual([2, 3]);
    expect(p.segments[1]!.confidence).toBe('uncertain');
    expect(p.confident).toBe(true);
  });

  it('длинный пакет перестаёт откатываться: сегменты укладываются в предел страниц', () => {
    // Пакет 2938e4c5: 8 страниц слиплись в один сегмент, он превысил предел в
    // 5 страниц, и сборка откатилась на «файл = документ» — после чего
    // одиночный путь прочитал только первые пять страниц из восьми.
    const cls = [
      page(1, 'upd_main', '4537'),
      page(2, 'upd_continuation', '4537'),
      page(3, 'upd_continuation', '4538'),
      page(4, 'upd_continuation', '4538'),
      page(5, 'upd_continuation', '4539'),
      page(6, 'upd_continuation', '4539'),
      page(7, 'upd_continuation', '4539'),
      page(8, 'upd_continuation', '4539'),
    ];
    expect(plan(cls, false).confident).toBe(false);
    const p = plan(cls, true);
    expect(p.confident).toBe(true);
    expect(p.segments.map((s) => s.pages)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6, 7, 8],
    ]);
  });
});

describe('лишний разрез: сомнение оставляет страницы вместе', () => {
  it('страница без номера продолжает текущий документ', () => {
    const cls = [
      page(1, 'upd_main', 'УТ-4304'),
      page(2, 'upd_continuation'),
      page(3, 'upd_continuation', 'УТ-4304'),
    ];
    expect(plan(cls, true).segments).toHaveLength(1);
  });

  it('потерянный префикс не повод резать', () => {
    const cls = [page(1, 'upd_main', 'УТ-4305'), page(2, 'upd_continuation', '4305')];
    expect(plan(cls, true).segments).toHaveLength(1);
  });

  it('тот же номер на шапке и обороте документ не дробит', () => {
    const cls = [
      page(1, 'upd_main', 'УТ-4304'),
      page(2, 'upd_continuation', 'УТ-4304'),
      page(3, 'upd_continuation', 'УТ-4304'),
    ];
    expect(plan(cls, true).segments).toHaveLength(1);
  });

  it('номер без цифр («б/н») границей не является', () => {
    const cls = [page(1, 'upd_main', 'УТ-4304'), page(2, 'upd_continuation', 'б/н')];
    expect(plan(cls, true).segments).toHaveLength(1);
  });
});
