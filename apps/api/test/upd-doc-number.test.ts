/**
 * Номер документа как признак границы: цена ошибки здесь несимметрична.
 *
 * Лишний разрез рвёт настоящий документ пополам и разносит его позиции по
 * двум карточкам; невыполненный разрез ловится аудитом нумерации и виден
 * менеджеру. Поэтому весь набор проверяет одно: «не знаю» обязано означать
 * «тот же документ».
 */
import { describe, expect, it } from 'vitest';
import {
  differentDocNumber,
  findNumberGaps,
  normalizeDocNumber,
} from '../src/domain/edo/upd-doc-number.js';

describe('normalizeDocNumber', () => {
  it('снимает «№» и лишние пробелы', () => {
    // Сравнивать нормализованное с кириллицей нельзя: гомоглифы уезжают в
    // латиницу намеренно. Важно, что обе записи сходятся к одному значению.
    expect(normalizeDocNumber('  № УТ-4304 ')).toBe(normalizeDocNumber('УТ-4304'));
    expect(normalizeDocNumber('УТ-4304')).not.toBeNull();
  });

  it('приводит кириллические гомоглифы к латинице', () => {
    // OCR читает один и тот же номер то с кириллической «С», то с латинской.
    expect(normalizeDocNumber('СУ-90')).toBe(normalizeDocNumber('CY-90'));
  });

  it('унифицирует разновидности тире', () => {
    expect(normalizeDocNumber('УТ–4304')).toBe(normalizeDocNumber('УТ-4304'));
  });

  it('номер без цифр не номер: по нему документы не различить', () => {
    expect(normalizeDocNumber('б/н')).toBeNull();
    expect(normalizeDocNumber('')).toBeNull();
    expect(normalizeDocNumber(null)).toBeNull();
  });
});

describe('differentDocNumber', () => {
  it('соседние номера серии — разные документы', () => {
    expect(differentDocNumber('УТ-4309', 'УТ-4308')).toBe(true);
    expect(differentDocNumber('0000-0082603', '0000-0082604')).toBe(true);
  });

  it('потерянный префикс не делает документ другим', () => {
    // Классификатор прочитал «4305», парсер — «УТ-4305». Резать нельзя.
    expect(differentDocNumber('УТ-4305', '4305')).toBe(false);
  });

  it('ведущие нули не считаются различием', () => {
    expect(differentDocNumber('УТ-004305', 'УТ-4305')).toBe(false);
  });

  it('неизвестность никогда не режет', () => {
    expect(differentDocNumber(null, 'УТ-4305')).toBe(false);
    expect(differentDocNumber('УТ-4305', undefined)).toBe(false);
    expect(differentDocNumber('б/н', 'УТ-4305')).toBe(false);
  });
});

describe('findNumberGaps', () => {
  it('находит пропуск боевого пакета 4304…4309 без 4308', () => {
    const gaps = findNumberGaps(['УТ-4304', 'УТ-4305', 'УТ-4306', 'УТ-4309', 'УТ-4307']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.missing).toEqual([4308]);
  });

  it('непрерывный ряд пропусков не даёт', () => {
    expect(findNumberGaps(['УТ-4304', 'УТ-4305', 'УТ-4306'])).toEqual([]);
  });

  it('ряд короче трёх документов ничего не доказывает', () => {
    expect(findNumberGaps(['УТ-4304', 'УТ-4309'])).toEqual([]);
  });

  it('большой разрыв — это разные отгрузки, а не потеря', () => {
    expect(findNumberGaps(['УТ-4304', 'УТ-4305', 'УТ-4320'])).toEqual([]);
  });

  it('разные префиксы в одну серию не смешиваются', () => {
    expect(findNumberGaps(['УТ-4304', 'УТ-4305', 'СФ-1', 'СФ-3', 'СФ-4'])).toEqual([
      // Префикс отдаётся как напечатан — в предупреждении менеджер должен
      // увидеть «СФ-2», а не латинизированное «CФ-2».
      expect.objectContaining({ prefix: 'СФ-', missing: [2] }),
    ]);
  });

  it('длинные идентификаторы ЭДО серией не считаются', () => {
    // Number на таких значениях теряет точность, и «пропуски» были бы выдуманы.
    expect(
      findNumberGaps(['201/2113428629-2', '201/2113428629-5', '201/21134286290000000001']),
    ).toEqual([]);
  });
});
