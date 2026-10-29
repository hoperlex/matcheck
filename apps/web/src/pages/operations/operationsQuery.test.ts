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
