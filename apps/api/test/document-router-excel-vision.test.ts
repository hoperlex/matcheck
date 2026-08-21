/**
 * Книга, непонятная структурному парсеру, просит доклассификацию по картинке.
 *
 * Раньше `excel:not-upd` был окончательным приговором: файл становился
 * заглушкой «не распознано», не увидев модели. Так за неделю потерялись 5 книг
 * из 28 — в том числе ТТН формы 1-Т «Стис», которую vision потом прочитал
 * верно (номер 1200-3843 из графы «№», стороны, позиция с суммами).
 *
 * Тест держит именно решение классификатора: тип остаётся unknown (пусть
 * решает модель), но needsVision поднят. Саму доклассификацию включает флаг
 * EXCEL_VISION_ROUTING в worker — без него ветка unknown отработает как раньше.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const probe = vi.hoisted(() => ({
  result: { confidence: 0, items: [] as unknown[] },
  // Плоский текст книги: тот же сборщик строк, что и у разбора УПД.
  rows: [] as { rowNumber: number; cells: Map<number, unknown>; text: string }[],
  // Сбой структурной пробы: парсер падает на битой/чужой книге, и это
  // отдельная ветка маршрута (excel:probe-failed).
  throws: false,
}));
vi.mock('../src/domain/edo/upd-xlsx.parser.js', () => ({
  parseUpdXlsx: () => {
    if (probe.throws) throw new Error('probe failed');
    return probe.result;
  },
  collectRowsViaSheetJS: () => probe.rows,
}));

const sheet = (...lines: string[]) =>
  lines.map((text, i) => ({ rowNumber: i + 1, cells: new Map<number, unknown>(), text }));

beforeEach(() => {
  probe.throws = false;
});

const { classifyFile } = await import('../src/domain/edo/document-router.js');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('document-router: Excel вне шаблонов УПД', () => {
  it('книга без полей шапки — unknown, но с запросом на vision', async () => {
    probe.result = { confidence: 0, items: [] };
    probe.rows = [];
    const c = await classifyFile(
      Buffer.from('xlsx'),
      XLSX_MIME,
      'Товарно-транспортная накладная (Стис) № 1200-3843 от 20.08.2026.xlsx',
    );
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
    expect(c.signals).toContain('excel:not-upd');
  });

  it('книга-УПД по-прежнему уходит в разбор без vision', async () => {
    probe.result = { confidence: 0.9, items: [{ nameRaw: 'Товар' }] };
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'УПД 123.xlsx');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
    expect(c.parserUsed).toBe('parseUpdXlsx');
  });

  it('книга с позициями, но без уверенности — тоже УПД, поведение прежнее', async () => {
    probe.result = { confidence: 0, items: [{ nameRaw: 'Товар' }] };
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'реализация.xlsx');
    expect(c.detectedKind).toBe('upd');
    expect(c.needsVision).toBe(false);
  });
});

describe('document-router: транспортная накладная, присланная книгой', () => {
  const waybillSheet = sheet(
    'Транспортная накладная № 199 от 21.08.2026',
    'Постановление Правительства РФ № 2116',
    'Грузоотправитель ООО «ЭлВаст»',
    'Грузополучатель ООО «АЛЬЯНС»',
  );

  it('уходит к промпту накладных, а не к УПД', async () => {
    // Боевой случай: структурный парсер находил в книге номер и дату, файл
    // признавался УПД, и промпт УПД отвечал «это транспортная накладная, графы
    // 1-11 отсутствуют» — ноль позиций и «распознано частично».
    probe.result = { confidence: 0.9, items: [{ nameRaw: 'Кирпич' }] };
    probe.rows = waybillSheet;
    const c = await classifyFile(
      Buffer.from('xlsx'),
      XLSX_MIME,
      'Транспортная накладная № 199 от 21.08.2026.xlsx',
      { excelRouting: true },
    );
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.parserUsed).toBe('parseWaybillBatch');
  });

  it('без рубильника маршрут прежний — книга остаётся УПД', async () => {
    probe.result = { confidence: 0.9, items: [{ nameRaw: 'Кирпич' }] };
    probe.rows = waybillSheet;
    const c = await classifyFile(
      Buffer.from('xlsx'),
      XLSX_MIME,
      'Транспортная накладная № 199 от 21.08.2026.xlsx',
    );
    expect(c.detectedKind).toBe('upd');
  });

  it('УПД, упомянувшая транспортную накладную, накладной не становится', async () => {
    // В шапке УПД есть строка «Данные о транспортировке и грузе» со ссылкой на
    // транспортную накладную. Приоритет остаётся за счётом-фактурой.
    probe.result = { confidence: 0.9, items: [{ nameRaw: 'Кабель' }] };
    probe.rows = sheet(
      'Универсальный передаточный документ',
      'Счёт-фактура № 42 от 21.08.2026',
      'Данные о транспортировке и грузе: транспортная накладная № 199',
      'Постановление Правительства РФ № 2116',
    );
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'УПД 42.xlsx', {
      excelRouting: true,
    });
    expect(c.detectedKind).toBe('upd');
  });
});

/**
 * Книга, которую структурный парсер УПД не понял, но которая является бланком
 * транспортной накладной.
 *
 * Боевой случай 21.08: НИ26-002357.xlsx — ТН по форме 2116 — осела заглушкой
 * «не распознано», не увидев модели. Ветка выше её не забирала: графа 4 бланка
 * («Сопроводительные документы на груз») ссылается на УПД, а признак
 * hasUpdMarker считает любое такое упоминание признаком счёта-фактуры.
 *
 * Новый маршрут стоит ПОСЛЕ структурной пробы, и это его главное свойство:
 * книга, в которой parseUpdXlsx нашёл хоть одно поле шапки или хоть одну
 * позицию, до него не доходит физически.
 */
describe('document-router: бланк ТН в книге, которую парсер УПД не понял', () => {
  // Текст боевой накладной: заголовок формы, разделы бланка и ссылка на УПД
  // в графе 4 — та самая, на которой спотыкался прежний признак.
  const waybillForm = () =>
    sheet(
      'Приложение № 4 к Правилам перевозок грузов автомобильным транспортом',
      '(в ред. Постановления Правительства РФ от 30.11.2021 № 2116)',
      'Транспортная накладная',
      'Дата 21.08.2026 № ТрН0000001',
      '1. Грузоотправитель Обособленное подразделение ООО «Пример», ИНН 0000000000',
      '2. Грузополучатель ООО «Получатель», ИНН 1111111111',
      '3. Груз Оборудование, 2 (два) грузовых места',
      '4. Сопроводительные документы на груз (при наличии)',
      'Универсальный передаточный документ ПР-000001 от 21.08.2026',
      '5. Указания грузоотправителя по особым условиям перевозки',
      '6. Перевозчик ИП Перевозчиков П.П., ИНН 222222222222',
    );

  it('уходит к промпту накладных, хотя в графе 4 упомянут УПД', async () => {
    probe.result = { confidence: 0, items: [] };
    probe.rows = waybillForm();
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'НИ00-000001.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('transport_waybill');
    expect(c.parserUsed).toBe('parseWaybillBatch');
    expect(c.needsVision).toBe(false);
    // Оба сигнала: по form:tn выбираются все срабатывания новой ветки.
    expect(c.signals).toEqual(expect.arrayContaining(['excel:not-upd', 'form:tn']));
  });

  it('без рубильника — прежняя заглушка «не распознано»', async () => {
    probe.result = { confidence: 0, items: [] };
    probe.rows = waybillForm();
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'НИ00-000001.xlsx');
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
    expect(c.signals).toContain('excel:not-upd');
    expect(c.signals).not.toContain('form:tn');
  });

  // Два теста, а не один: условие маршрута — ИЛИ (confidence > 0 || позиции),
  // и одна проверка «0.9 и позиции» не доказывает обе половины по отдельности.
  it('книга, распознанная по confidence, остаётся УПД даже при рубильнике', async () => {
    probe.result = { confidence: 0.9, items: [] };
    probe.rows = waybillForm();
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'НИ00-000001.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdXlsx');
  });

  it('книга, распознанная по позициям, остаётся УПД даже при рубильнике', async () => {
    probe.result = { confidence: 0, items: [{ nameRaw: 'Кабель' }] };
    probe.rows = waybillForm();
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'НИ00-000001.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('upd');
    expect(c.parserUsed).toBe('parseUpdXlsx');
  });

  it('сбой структурной пробы маршрут не меняет — книга идёт в УПД, как раньше', async () => {
    probe.throws = true;
    probe.rows = waybillForm();
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'НИ00-000001.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('upd');
    expect(c.signals).toContain('excel:probe-failed');
  });

  it('спецификация со ссылкой на накладную накладной не становится', async () => {
    // Заголовок в тексте есть, нумерованный список есть — но это не разделы
    // бланка ТН. Прежний признак (hasNumberedWaybillSections) здесь бы сработал.
    probe.result = { confidence: 0, items: [] };
    probe.rows = sheet(
      'Спецификация № 7 к договору поставки',
      '1. Предмет договора и порядок поставки',
      '2. Цена и порядок расчетов',
      '3. Порядок приемки: товар передается по накладной',
      'Отгрузочные документы: транспортная накладная оформляется перевозчиком',
      '4. Ответственность сторон',
    );
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'спецификация.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
  });

  it('один раздел, повторённый дважды, порога не набирает', async () => {
    probe.result = { confidence: 0, items: [] };
    probe.rows = sheet(
      'Транспортная накладная',
      '1. Грузоотправитель ООО «Пример»',
      '1. Грузоотправитель (продолжение) адрес склада',
    );
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'обрывок.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('unknown');
  });

  it('прайс без признаков накладной — прежняя заглушка', async () => {
    probe.result = { confidence: 0, items: [] };
    probe.rows = sheet('Прайс-лист на 21.08.2026', 'Наименование Цена', 'Кабель 120,50');
    const c = await classifyFile(Buffer.from('xlsx'), XLSX_MIME, 'прайс.xlsx', {
      excelWaybillTextRoute: true,
    });
    expect(c.detectedKind).toBe('unknown');
    expect(c.needsVision).toBe(true);
  });
});
