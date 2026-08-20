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
import { describe, it, expect, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  result: { confidence: 0, items: [] as unknown[] },
  // Плоский текст книги: тот же сборщик строк, что и у разбора УПД.
  rows: [] as { rowNumber: number; cells: Map<number, unknown>; text: string }[],
}));
vi.mock('../src/domain/edo/upd-xlsx.parser.js', () => ({
  parseUpdXlsx: () => probe.result,
  collectRowsViaSheetJS: () => probe.rows,
}));

const sheet = (...lines: string[]) =>
  lines.map((text, i) => ({ rowNumber: i + 1, cells: new Map<number, unknown>(), text }));

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
