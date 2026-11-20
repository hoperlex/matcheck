import { describe, expect, it } from 'vitest';
import {
  OPERATIONS_FILTER_KEYS,
  hasOperationsFilters,
  operationsListQuery,
  readOperationsFilters,
  withoutOperationsFilters,
} from './operationsQuery';

describe('operationsListQuery: отметка «Диспетчер»', () => {
  it('из адреса ?dispatcher= уходит в dispatcherCheck у приёмок', () => {
    const filters = readOperationsFilters(new URLSearchParams('dispatcher=none&review=approved'));
    const qs = operationsListQuery(filters, { kind: 'delivery' });
    expect(qs.get('dispatcherCheck')).toBe('none');
    expect(qs.get('reviewState')).toBe('approved');
  });

  it('у отгрузок отметки нет — параметр не уходит', () => {
    const filters = readOperationsFilters(new URLSearchParams('dispatcher=checked'));
    const qs = operationsListQuery(filters, { kind: 'shipment' });
    expect(qs.has('dispatcherCheck')).toBe(false);
  });
});

describe('operationsListQuery: вид операции (ручной внос / с машиной)', () => {
  it.each(['delivery', 'shipment'] as const)('%s: ?entry= уходит на сервер как есть', (kind) => {
    for (const entry of ['manual', 'vehicle']) {
      const filters = readOperationsFilters(new URLSearchParams(`entry=${entry}`));
      expect(operationsListQuery(filters, { kind }).get('entry')).toBe(entry);
    }
  });

  it('чужое значение из ссылки не уходит (сервер ответил бы 400 вместо таблицы)', () => {
    const filters = readOperationsFilters(new URLSearchParams('entry=yes'));
    expect(filters.entry).toBeNull();
    expect(operationsListQuery(filters, { kind: 'delivery' }).has('entry')).toBe(false);
  });
});

describe('operationsListQuery: «Признак приёмки» / «Тип отгрузки»', () => {
  it('у приёмки уходят только известные коды, в порядке пунктов', () => {
    const filters = readOperationsFilters(
      new URLSearchParams('purpose=none&purpose=foo&purpose=tolling_act&purpose=none'),
    );
    expect(operationsListQuery(filters, { kind: 'delivery' }).get('purposes')).toBe(
      'tolling_act,none',
    );
  });

  it('у приёмки одни чужие значения (тип отгрузки из старой ссылки) — параметра нет', () => {
    const filters = readOperationsFilters(new URLSearchParams('purpose=Вывоз+материала'));
    expect(operationsListQuery(filters, { kind: 'delivery' }).has('purposes')).toBe(false);
  });

  it('у отгрузки «Тип отгрузки» уходит как раньше', () => {
    const filters = readOperationsFilters(
      new URLSearchParams('purpose=Вывоз+материала&purpose=Другое'),
    );
    expect(operationsListQuery(filters, { kind: 'shipment' }).get('purposes')).toBe(
      'Вывоз материала,Другое',
    );
  });
});

describe('«Сбросить» в «Принятых»', () => {
  // Шпион за чтением адреса: какие ключи на самом деле читает
  // readOperationsFilters. Список сброса обязан совпадать с ним — иначе новый
  // фильтр переживал бы «Сбросить» и продолжал сужать таблицу.
  class ReadSpy extends URLSearchParams {
    readonly readKeys = new Set<string>();
    override get(name: string) {
      this.readKeys.add(name);
      return super.get(name);
    }
    override getAll(name: string) {
      this.readKeys.add(name);
      return super.getAll(name);
    }
  }

  it('снимает ровно те ключи, что читает readOperationsFilters', () => {
    const spy = new ReadSpy();
    readOperationsFilters(spy);
    expect([...spy.readKeys].sort()).toEqual([...OPERATIONS_FILTER_KEYS].sort());
  });

  it('оставляет вкладку, тип и «Удалённые», снимает страницу', () => {
    const params = new URLSearchParams(
      'type=shipment&tab=accepted&trash=1&page=3&site=s1&feature=a&feature=b&purpose=x&dfrom=2026-11-01',
    );
    expect(hasOperationsFilters(params)).toBe(true);
    const next = withoutOperationsFilters(params);
    expect(next.toString()).toBe('type=shipment&tab=accepted&trash=1');
    expect(hasOperationsFilters(next)).toBe(false);
    expect(readOperationsFilters(next)).toEqual(readOperationsFilters(new URLSearchParams()));
  });
});
