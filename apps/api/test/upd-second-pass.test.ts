/**
 * Второй проход распознавания: дозаполнение сторон и арбитраж результатов.
 *
 * Обе функции чистые, и обе защищают от конкретных наблюдавшихся отказов:
 *   * fillPartiesFromText — модель вернула позиции и суммы, но `supplier` и
 *     `recipient` пустые (5 случаев из 96 вызовов на проде), хотя в тексте
 *     стороны есть;
 *   * chooseBetterUpdResult — повторный vision может вернуть больше строк, но
 *     хуже сходящихся, и наивное «у кого больше позиций» затёрло бы корректный
 *     текстовый разбор.
 */
import { describe, expect, it } from 'vitest';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { fillPartiesFromText } from '../src/domain/edo/upd-pdf.parser.js';
import { chooseBetterUpdResult, mergeParties } from '../src/domain/edo/upd-result-compare.js';

// Фрагмент реального документа из инцидента UT-3843: qwen вернул все стороны
// как null, хотя текст содержит и продавца, и покупателя, и грузополучателя.
const UT3843_TEXT = [
  'Счет-фактура № UT-3843 от 30.12.2025 (1)',
  'Исправление № от (1a)',
  'Продавец ООО "Компенсатор" (2)',
  'Адрес 109316, 77, г. Москва, Остаповский пр-д, д. № 5/1, офис 204 (2а)',
  'ИНН/КПП 7722466900 / 772201001 (2б)',
  'Грузоотправитель и его адрес он же (3)',
  'Грузополучатель и его адрес ООО "АЛЬЯНС", 129344, 77, г. Москва, ул. Искры, д. 31',
  '(4)',
  'Покупатель ООО "СУ-10" (6)',
  'Адрес РОССИЯ, 117335, Москва г, ул. Вавилова, д. 69/75 (6а)',
  'ИНН/КПП 7736255508 / 773601001 (6б)',
].join('\n');

function parsedWith(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: 'UT-3843',
    docDate: '2025-12-30',
    totalSum: 403098,
    vatSum: 67183,
    itemsCount: 1,
    supplier: null,
    recipient: null,
    consignee: null,
    items: [{ nameRaw: 'Компенсатор сильфонный', qty: 2, unit: 'шт', price: 100, sum: 200 }],
    confidence: 1,
    ...over,
  } as UpdPdfParsed;
}

describe('fillPartiesFromText — стороны, когда модель промолчала', () => {
  it('все стороны пусты → добираются из текста', () => {
    const { parsed, filled } = fillPartiesFromText(parsedWith(), UT3843_TEXT);
    expect(filled.sort()).toEqual(['consignee', 'recipient', 'supplier']);
    expect(parsed.supplier?.inn).toBe('7722466900');
    expect(parsed.recipient?.inn).toBe('7736255508');
    // Графу 4 печатают без ИНН — сторона сохраняется только по имени.
    expect(parsed.consignee?.name).toBe('ООО "АЛЬЯНС"');
    expect(parsed.consignee?.inn ?? null).toBeNull();
  });

  it('сторона от модели не перезаписывается, даже неполная', () => {
    // Имя без ИНН — это не «пусто»: модель видела документ целиком, и подменять
    // её результат эвристикой на регулярках незачем.
    const input = parsedWith({ supplier: { inn: null, kpp: null, name: 'ООО «Другой»' } });
    const { parsed, filled } = fillPartiesFromText(input, UT3843_TEXT);
    expect(parsed.supplier?.name).toBe('ООО «Другой»');
    expect(filled).not.toContain('supplier');
    expect(filled).toContain('recipient');
  });

  it('все стороны заполнены → локальный парсер не нужен, объект тот же', () => {
    const input = parsedWith({
      supplier: { inn: '1', kpp: null, name: 'A' },
      recipient: { inn: '2', kpp: null, name: 'B' },
      consignee: { inn: null, kpp: null, name: 'C' },
    });
    const { parsed, filled } = fillPartiesFromText(input, UT3843_TEXT);
    expect(filled).toEqual([]);
    expect(parsed).toBe(input);
  });

  it('текст без сторон → ничего не выдумывает', () => {
    const { parsed, filled } = fillPartiesFromText(parsedWith(), 'Просто текст без реквизитов');
    expect(filled).toEqual([]);
    expect(parsed.supplier).toBeNull();
  });

  it('позиции и суммы не трогаются', () => {
    const input = parsedWith();
    const { parsed } = fillPartiesFromText(input, UT3843_TEXT);
    expect(parsed.items).toEqual(input.items);
    expect(parsed.totalSum).toBe(input.totalSum);
    expect(parsed.docNumber).toBe(input.docNumber);
  });
});

describe('chooseBetterUpdResult — что принимаем со второго прохода', () => {
  const good = parsedWith({
    items: [{ nameRaw: 'Труба', qty: 2, unit: 'шт', price: 100, sum: 200 }],
    totalSum: 200,
    vatSum: null,
    itemsCount: 1,
  });

  it('пустые позиции проигрывают непустым', () => {
    const empty = parsedWith({ items: [], itemsCount: null });
    expect(chooseBetterUpdResult(empty, good).winner).toBe('candidate');
    expect(chooseBetterUpdResult(good, empty).winner).toBe('base');
  });

  it('полная шапка без единой позиции проигрывает списку материалов', () => {
    // Приёмка идёт по списку материалов: документ без строк инспектору
    // бесполезен, какой бы полной ни была шапка. Раньше сравнение начиналось
    // с шапки, и такой кандидат побеждал — против цели «номер + материалы».
    const headerOnly = parsedWith({
      docNumber: 'УТ-9',
      docDate: '2026-08-17',
      totalSum: 999,
      items: [],
      itemsCount: null,
    });
    const itemsNoDate = parsedWith({
      docNumber: 'УТ-9',
      docDate: null,
      totalSum: null,
      items: [{ nameRaw: 'Труба', qty: 2, unit: 'шт', price: 100, sum: 200 }],
      itemsCount: null,
    });

    expect(chooseBetterUpdResult(headerOnly, itemsNoDate).winner).toBe('candidate');
    expect(chooseBetterUpdResult(itemsNoDate, headerOnly).winner).toBe('base');
  });

  it('полная шапка важнее при равной полноте списка', () => {
    const noTotal = parsedWith({
      totalSum: null,
      items: [
        { nameRaw: 'A', qty: 1, unit: 'шт', price: 1, sum: 1 },
        { nameRaw: 'B', qty: 1, unit: 'шт', price: 1, sum: 1 },
        { nameRaw: 'C', qty: 1, unit: 'шт', price: 1, sum: 1 },
      ],
      itemsCount: 3,
    });
    // У кандидата втрое больше строк, но нет итога — документ с таким набором
    // даже не может стать 'parsed'.
    expect(chooseBetterUpdResult(good, noTotal).winner).toBe('base');
  });

  it('больше позиций, но суммы не сходятся → проигрывает', () => {
    // Ровно тот случай, ради которого правило «больше строк = лучше» опасно:
    // vision дописал строки, и итог перестал сходиться.
    const hallucinated = parsedWith({
      totalSum: 200,
      vatSum: null,
      itemsCount: 1,
      items: [
        { nameRaw: 'Труба', qty: 2, unit: 'шт', price: 100, sum: 200 },
        { nameRaw: 'Выдуманная строка', qty: 5, unit: 'шт', price: 1000, sum: 5000 },
      ],
    });
    expect(chooseBetterUpdResult(good, hallucinated).winner).toBe('base');
  });

  it('при прочих равных больше позиций выигрывает', () => {
    const more = parsedWith({
      totalSum: 400,
      vatSum: null,
      itemsCount: 2,
      items: [
        { nameRaw: 'Труба', qty: 2, unit: 'шт', price: 100, sum: 200 },
        { nameRaw: 'Отвод', qty: 2, unit: 'шт', price: 100, sum: 200 },
      ],
    });
    expect(chooseBetterUpdResult(good, more).winner).toBe('candidate');
  });

  it('равные результаты → остаётся сохранённый', () => {
    expect(chooseBetterUpdResult(good, parsedWith({ ...good })).winner).toBe('base');
  });
});

describe('mergeParties — стороны переживают замену результата', () => {
  it('грузополучатель из baseline сохраняется при победе vision', () => {
    // Активный промпт v8 грузополучателя не запрашивает вовсе: без слияния
    // успешный второй проход обнулил бы сторону, добранную из текста.
    const baseline = parsedWith({
      supplier: { inn: '7722466900', kpp: null, name: 'ООО "Компенсатор"' },
      consignee: { inn: null, kpp: null, name: 'ООО "АЛЬЯНС"' },
    });
    const winner = parsedWith({
      supplier: { inn: '7722466900', kpp: '772201001', name: 'ООО "Компенсатор"' },
      consignee: null,
    });
    const merged = mergeParties(winner, baseline);
    expect(merged.consignee?.name).toBe('ООО "АЛЬЯНС"');
    // Сторону, которую вернул победитель, не подменяем — у неё есть КПП.
    expect(merged.supplier?.kpp).toBe('772201001');
  });

  it('нечего переносить → возвращается тот же объект', () => {
    const winner = parsedWith({ supplier: { inn: '1', kpp: null, name: 'A' } });
    expect(mergeParties(winner, parsedWith())).toBe(winner);
  });

  // Ниже — слияние ПОЛЕЙ, а не целых сторон. Без него ИНН, добытый первым
  // проходом, исчезал при победе vision: сторона с именем не пуста, и правило
  // «переносим сторону целиком, если её нет» её не трогало. С сохранением ИНН
  // в source_documents (миграция 0095) такая потеря стала видимой — вторая
  // строка ячейки в списке просто пустела после второго прохода.
  it('имя осталось, ИНН пропал → ИНН и КПП добираются из baseline', () => {
    const baseline = parsedWith({
      recipient: { inn: '7736255508', kpp: '773601001', name: 'ООО "СУ-10"' },
    });
    const winner = parsedWith({
      recipient: { inn: null, kpp: null, name: 'ООО «СУ-10»' },
    });
    const merged = mergeParties(winner, baseline);
    expect(merged.recipient?.inn).toBe('7736255508');
    expect(merged.recipient?.kpp).toBe('773601001');
    // Имя берём победителя: он видел документ последним.
    expect(merged.recipient?.name).toBe('ООО «СУ-10»');
  });

  it('другая организация → ИНН не переносится', () => {
    // Худший исход не «ИНН пустой», а «ИНН чужой»: по нему сверяют документ.
    const baseline = parsedWith({
      recipient: { inn: '7736255508', kpp: '773601001', name: 'ООО "СУ-10"' },
    });
    const winner = parsedWith({
      recipient: { inn: null, kpp: null, name: 'ООО "СТРОЙДЕТАЛЬ"' },
    });
    const merged = mergeParties(winner, baseline);
    expect(merged.recipient?.inn ?? null).toBeNull();
    expect(merged.recipient?.name).toBe('ООО "СТРОЙДЕТАЛЬ"');
  });

  it('ИНН у обоих, но разные → сторона не дозаполняется', () => {
    // Имена совпадают (дубли по названию реальны), решает ИНН — он уникален.
    const baseline = parsedWith({
      supplier: { inn: '7736255508', kpp: '773601001', name: 'ООО "Компенсатор"' },
    });
    const winner = parsedWith({
      supplier: { inn: '7722466900', kpp: null, name: 'ООО "Компенсатор"' },
    });
    const merged = mergeParties(winner, baseline);
    expect(merged.supplier?.inn).toBe('7722466900');
    expect(merged.supplier?.kpp ?? null).toBeNull();
  });

  it('нечитаемый ИНН у победителя → решают имена, ИНН baseline подставляется', () => {
    // У модели на плохих сканах выпадают цифры: '773625550' не проходит
    // проверку контрольных сумм, и как признак организации не годится.
    const baseline = parsedWith({
      recipient: { inn: '7736255508', kpp: null, name: 'ООО "СУ-10"' },
    });
    const winner = parsedWith({
      recipient: { inn: null, kpp: null, name: 'ООО "СУ-10"' },
    });
    const merged = mergeParties(winner, baseline);
    expect(merged.recipient?.inn).toBe('7736255508');
  });
});
