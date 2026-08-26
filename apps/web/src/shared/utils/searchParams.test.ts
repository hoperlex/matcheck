/**
 * Патч query-параметров: три значения — три смысла.
 *
 * Ради этого разделения функция и появилась: панель фильтров шлёт частичный
 * патч, недостающие ключи родитель заполняет `undefined`, и ровно они раньше
 * доходили до `delete` — выбранный объект слетал при вводе номера документа.
 */
import { describe, expect, it } from 'vitest';
import { patchSearchParams } from './searchParams';

const base = () => new URLSearchParams('direction=inbound&contractor=c1&supplier=s1&site=st1');

describe('patchSearchParams', () => {
  it('undefined не трогает параметр', () => {
    const next = patchSearchParams(base(), {
      contractor: undefined,
      supplier: undefined,
      site: undefined,
      q: 'УТ-10354',
    });

    expect(next.get('contractor')).toBe('c1');
    expect(next.get('supplier')).toBe('s1');
    expect(next.get('site')).toBe('st1');
    expect(next.get('q')).toBe('УТ-10354');
    expect(next.get('direction')).toBe('inbound');
  });

  it('null и пустая строка снимают параметр', () => {
    const next = patchSearchParams(base(), { contractor: null, supplier: '' });

    expect(next.has('contractor')).toBe(false);
    expect(next.has('supplier')).toBe(false);
    expect(next.get('site')).toBe('st1');
  });

  it('не мутирует исходный набор', () => {
    const current = base();
    patchSearchParams(current, { site: null, q: 'x' });

    expect(current.get('site')).toBe('st1');
    expect(current.has('q')).toBe(false);
  });

  it('выбор объекта не сбрасывает уже введённый номер документа', () => {
    const withQuery = new URLSearchParams('q=%D0%A3%D0%A2-1&direction=inbound');
    const next = patchSearchParams(withQuery, { site: 'st2', contractor: undefined });

    expect(next.get('q')).toBe('УТ-1');
    expect(next.get('site')).toBe('st2');
  });
});
