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

const probe = vi.hoisted(() => ({ result: { confidence: 0, items: [] as unknown[] } }));
vi.mock('../src/domain/edo/upd-xlsx.parser.js', () => ({
  parseUpdXlsx: () => probe.result,
}));

const { classifyFile } = await import('../src/domain/edo/document-router.js');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('document-router: Excel вне шаблонов УПД', () => {
  it('книга без полей шапки — unknown, но с запросом на vision', async () => {
    probe.result = { confidence: 0, items: [] };
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
