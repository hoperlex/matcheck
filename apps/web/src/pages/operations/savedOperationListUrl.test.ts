import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { recordListUrl } from '../../shared/listMemory';
import {
  closedOperationListUrl,
  purgedOperationListUrl,
  savedOperationListUrl,
} from './savedOperationListUrl';

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

  it('keeps list filters after purging a record from the trash', () => {
    const params = new URLSearchParams({
      type: 'shipment',
      tab: 'accepted',
      trash: '1',
      page: '2',
      site: 'site-1',
      dfrom: '2026-11-01',
      shipment: 'operation-1',
      from: 'list',
    });

    const url = new URL(purgedOperationListUrl(params, 'shipment'), 'https://example.test');
    expect(url.searchParams.get('trash')).toBe('1');
    expect(url.searchParams.get('tab')).toBe('accepted');
    expect(url.searchParams.get('site')).toBe('site-1');
    expect(url.searchParams.get('dfrom')).toBe('2026-11-01');
    expect(url.searchParams.has('shipment')).toBe(false);
  });
});

describe('returning to the History of receipts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.getState().clear();
  });

  it.each([
    ['close', closedOperationListUrl],
    ['save', savedOperationListUrl],
  ] as const)('%s leads back to History with its filters', (_name, build) => {
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    });
    useAuthStore.getState().setUser({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'x@test',
      role: 'manager',
    } as UserDto);
    recordListUrl('/materials', '?type=shipment&dfrom=2026-11-01&page=3');

    const params = new URLSearchParams({
      type: 'delivery',
      delivery: 'operation-1',
      from: 'materials',
    });
    const url = new URL(build(params, 'delivery'), 'https://example.test');
    expect(url.pathname).toBe('/materials');
    expect(url.searchParams.get('type')).toBe('shipment');
    expect(url.searchParams.get('dfrom')).toBe('2026-11-01');
    expect(url.searchParams.get('page')).toBe('3');
  });
});
