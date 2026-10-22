import { describe, expect, it } from 'vitest';
import { closedOperationListUrl, savedOperationListUrl } from './savedOperationListUrl';

describe('savedOperationListUrl', () => {
  it.each(['delivery', 'shipment'] as const)(
    'keeps the current accepted page and filters after saving a %s',
    (type) => {
      const params = new URLSearchParams({
        type,
        tab: 'accepted',
        page: '9',
        supplier: 'supplier-1',
        [type]: 'operation-1',
        from: type === 'delivery' ? 'accepted' : 'list',
      });

      const url = new URL(savedOperationListUrl(params, type), 'https://example.test');
      expect(url.pathname).toBe('/operations');
      expect(url.searchParams.get('page')).toBe('9');
      expect(url.searchParams.get('supplier')).toBe('supplier-1');
      expect(url.searchParams.get('tab')).toBe('accepted');
      expect(url.searchParams.has(type)).toBe(false);
      expect(url.searchParams.has('from')).toBe(false);
      expect(params.get(type)).toBe('operation-1');
    },
  );

  it('starts at the first accepted page when saving from Expected', () => {
    const params = new URLSearchParams({
      type: 'delivery',
      tab: 'expected',
      page: '9',
      delivery: 'new-operation',
      new: '1',
      upd: 'document-1',
    });

    const url = new URL(savedOperationListUrl(params, 'delivery'), 'https://example.test');
    expect(url.searchParams.get('tab')).toBe('accepted');
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('delivery')).toBe(false);
    expect(url.searchParams.has('new')).toBe(false);
    expect(url.searchParams.has('upd')).toBe(false);
  });

  it('keeps the current page when closing a delivery without saving', () => {
    const params = new URLSearchParams({
      type: 'delivery',
      tab: 'accepted',
      page: '9',
      supplier: 'supplier-1',
      delivery: 'operation-1',
      from: 'accepted',
    });

    const url = new URL(closedOperationListUrl(params, 'delivery'), 'https://example.test');
    expect(url.searchParams.get('page')).toBe('9');
    expect(url.searchParams.get('supplier')).toBe('supplier-1');
    expect(url.searchParams.get('tab')).toBe('accepted');
    expect(url.searchParams.has('delivery')).toBe(false);
  });
});
