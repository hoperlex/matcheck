import { describe, expect, it } from 'vitest';
import { operationsListQuery, readOperationsFilters } from './operationsQuery';

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
