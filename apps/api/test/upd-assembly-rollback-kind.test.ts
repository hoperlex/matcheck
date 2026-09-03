/**
 * Откат сборки перестаёт отправлять любой файл в УПД-парсер.
 *
 * На бою за две недели 50 файлов ушли в УПД-парсер после отката с причиной
 * «нет ни одной УПД-страницы» — то есть система проигнорировала собственный
 * вывод. Среди них регулярная серия транспортных накладных «Боневит», которые
 * так и лежат в системе как УПД.
 *
 * Правило намеренно узкое: вид меняется только у ОДНОРОДНОГО файла. Смешанный
 * разбирать здесь нельзя — угадывание «по большинству» теряет документы ровно
 * тем же способом, от которого мы уходим.
 */
import { describe, expect, it } from 'vitest';
import { rollbackKindsByFile } from '../src/domain/edo/upd-assembly.js';
import type { PageClassification } from '../src/domain/edo/upd-page-prefilter.js';

const cls = (page: number, type: PageClassification['type']): PageClassification => ({
  page,
  type,
  use: true,
});
const ref = (globalPage: number, registryItemId: string | null) => ({ globalPage, registryItemId });

describe('rollbackKindsByFile', () => {
  it('файл целиком из накладных уходит в waybill-парсер', () => {
    const kinds = rollbackKindsByFile(
      [cls(1, 'transport_waybill'), cls(2, 'transport_waybill')],
      [ref(1, 'file-1'), ref(2, 'file-1')],
    );
    expect(kinds.get('file-1')).toBe('transport_waybill');
  });

  it('файл целиком из сертификатов — сопроводительный', () => {
    const kinds = rollbackKindsByFile([cls(1, 'certificate')], [ref(1, 'file-1')]);
    expect(kinds.get('file-1')).toBe('supplementary');
  });

  it('хотя бы одна УПД-страница — маршрут прежний', () => {
    const kinds = rollbackKindsByFile(
      [cls(1, 'transport_waybill'), cls(2, 'upd_main')],
      [ref(1, 'file-1'), ref(2, 'file-1')],
    );
    expect(kinds.has('file-1')).toBe(false);
  });

  it('смешанный набор чужих видов тоже не трогаем', () => {
    const kinds = rollbackKindsByFile(
      [cls(1, 'transport_waybill'), cls(2, 'certificate')],
      [ref(1, 'file-1'), ref(2, 'file-1')],
    );
    expect(kinds.has('file-1')).toBe(false);
  });

  it('неупомянутая классификатором страница делает файл неоднородным', () => {
    // О ней не известно ничего, и «остальные же накладные» — не довод.
    const kinds = rollbackKindsByFile(
      [cls(1, 'transport_waybill')],
      [ref(1, 'file-1'), ref(2, 'file-1')],
    );
    expect(kinds.has('file-1')).toBe(false);
  });

  it('решение принимается по каждому файлу отдельно', () => {
    const kinds = rollbackKindsByFile(
      [cls(1, 'transport_waybill'), cls(2, 'upd_main')],
      [ref(1, 'file-1'), ref(2, 'file-2')],
    );
    expect(kinds.get('file-1')).toBe('transport_waybill');
    expect(kinds.has('file-2')).toBe(false);
  });

  it('пустая классификация ничего не переключает', () => {
    expect(rollbackKindsByFile([], [ref(1, 'file-1')]).size).toBe(0);
  });
});
