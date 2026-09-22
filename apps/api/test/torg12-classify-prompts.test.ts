/**
 * Тексты промптов, знающих товарную накладную ТОРГ-12.
 *
 * Главное здесь — не новый текст, а СТАРЫЙ: пока рубильники выключены,
 * модель обязана получать ровно тот же промпт, что и до правки. Иначе
 * выкладка кода сама, без поворота рубильника, поменяла бы классификацию
 * всему потоку — 1041 файл в месяц уходит в УПД по вердикту картинки, и
 * незаметного регресса тут быть не должно.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/client.js', () => ({ db: {} }));

const {
  PAGE_CLASSIFY_PROMPT,
  PAGE_CLASSIFY_WITH_NUMBER_PROMPT,
  PAGE_CLASSIFY_TORG12_PROMPT,
  PAGE_CLASSIFY_TORG12_WITH_NUMBER_PROMPT,
  pageClassifyPrompt,
  parseClassification,
} = await import('../src/domain/edo/upd-page-prefilter.js');

const { CLASSIFY_PROMPT, CLASSIFY_PROMPT_TORG12 } = await import(
  '../src/domain/edo/vision-classifier.js'
);

describe('выбор промпта классификации страниц', () => {
  it('без признаков — прежний текст, ни одним символом не отличающийся', () => {
    expect(pageClassifyPrompt({})).toBe(PAGE_CLASSIFY_PROMPT);
    expect(pageClassifyPrompt({ withDocNumber: false, torg12: false })).toBe(PAGE_CLASSIFY_PROMPT);
  });

  it('расширенный промпт с номерами остался прежним: базовый текст плюс хвост', () => {
    expect(pageClassifyPrompt({ withDocNumber: true })).toBe(PAGE_CLASSIFY_WITH_NUMBER_PROMPT);
    expect(PAGE_CLASSIFY_WITH_NUMBER_PROMPT.startsWith(PAGE_CLASSIFY_PROMPT)).toBe(true);
    expect(PAGE_CLASSIFY_WITH_NUMBER_PROMPT).toContain('"docNumber"');
  });

  it('прежние тексты о ТОРГ-12 и М-15 не знают', () => {
    for (const prompt of [PAGE_CLASSIFY_PROMPT, PAGE_CLASSIFY_WITH_NUMBER_PROMPT, CLASSIFY_PROMPT]) {
      expect(prompt).not.toContain('ТОРГ-12');
      expect(prompt).not.toContain('0330212');
    }
    // Прежний классификатор файла форму М-15 знает и без правки — это его
    // ветка, и она обязана остаться на месте.
    expect(CLASSIFY_PROMPT).toContain('М-15');
    expect(PAGE_CLASSIFY_PROMPT).not.toContain('"m15"');
  });

  it('все четыре сочетания рубильников дают свой текст', () => {
    const texts = [
      pageClassifyPrompt({}),
      pageClassifyPrompt({ withDocNumber: true }),
      pageClassifyPrompt({ torg12: true }),
      pageClassifyPrompt({ withDocNumber: true, torg12: true }),
    ];
    expect(new Set(texts).size).toBe(4);
    expect(texts[2]).toBe(PAGE_CLASSIFY_TORG12_PROMPT);
    expect(texts[3]).toBe(PAGE_CLASSIFY_TORG12_WITH_NUMBER_PROMPT);
  });

  it('новый текст описывает ТОРГ-12, её продолжение и ловушку «Транспортная накладная»', () => {
    expect(PAGE_CLASSIFY_TORG12_PROMPT).toContain('0330212');
    expect(PAGE_CLASSIFY_TORG12_PROMPT).toContain('Всего по накладной');
    expect(PAGE_CLASSIFY_TORG12_PROMPT).toContain('"m15"');
    // Ровно та ловушка, на которой споткнулся боевой случай: рамка ТН в углу
    // товарной накладной.
    expect(PAGE_CLASSIFY_TORG12_PROMPT).toMatch(/рамка «Транспортная накладная»/);
  });

  it('вариант с номерами добавляет графу «Номер документа» ТОРГ-12', () => {
    expect(PAGE_CLASSIFY_TORG12_WITH_NUMBER_PROMPT.startsWith(PAGE_CLASSIFY_TORG12_PROMPT)).toBe(
      true,
    );
    expect(PAGE_CLASSIFY_TORG12_WITH_NUMBER_PROMPT).toContain('«Номер документа»');
  });
});

describe('разбор ответа с типом m15', () => {
  it('новый тип читается и страницу из разбора НЕ выкидывает', () => {
    // use=false означает «страница не пойдёт в extract»; для m15 это было бы
    // потерей файла, у которого других страниц нет.
    const out = parseClassification('{"pages":[{"page":1,"type":"m15"}]}', 1);
    expect(out).toEqual([{ page: 1, type: 'm15', use: true }]);
  });

  it('ответ прежнего промпта разбирается ровно как раньше', () => {
    const out = parseClassification(
      '{"pages":[{"page":1,"type":"upd_main"},{"page":2,"type":"transport_waybill"}]}',
      2,
    );
    expect(out).toEqual([
      { page: 1, type: 'upd_main', use: true },
      { page: 2, type: 'transport_waybill', use: false },
    ]);
  });
});

describe('промпт классификатора файла с ТОРГ-12', () => {
  it('ведёт товарную накладную и её лист-продолжение в УПД-путь', () => {
    expect(CLASSIFY_PROMPT_TORG12).toContain('ТОВАРНАЯ НАКЛАДНАЯ');
    expect(CLASSIFY_PROMPT_TORG12).toContain('0330212');
    expect(CLASSIFY_PROMPT_TORG12).toContain('ЛИСТ-ПРОДОЛЖЕНИЕ');
  });

  it('сохраняет прежние виды: накладная, М-15, сертификат', () => {
    for (const kind of ['"transport_waybill"', '"m15"', '"supplementary"', '"unknown"']) {
      expect(CLASSIFY_PROMPT_TORG12).toContain(kind);
    }
  });
});
