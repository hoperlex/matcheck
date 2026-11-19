// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../stores/auth';
import { useGlobalFiltersStore } from '../stores/globalFilters';
import {
  applyOperationsTabMemory,
  operationCardUrl,
  pageUrl,
  recordListUrl,
  sectionUrl,
} from './listMemory';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function login(id: string) {
  useAuthStore.getState().setUser({ id, email: 'x@test', role: 'manager' } as UserDto);
}

function query(url: string): URLSearchParams {
  return new URL(url, 'https://example.test').searchParams;
}

function path(url: string): string {
  return new URL(url, 'https://example.test').pathname;
}

beforeEach(() => {
  sessionStorage.clear();
  login(USER_A);
  useGlobalFiltersStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.getState().clear();
});

describe('listMemory', () => {
  it('menu returns to the last place inside the section with its filters', () => {
    recordListUrl(
      '/operations',
      '?type=delivery&tab=accepted&dfrom=2026-11-01&feature=transit&page=2',
    );
    recordListUrl('/documents', '?direction=outbound');

    const url = sectionUrl('/operations');
    expect(path(url)).toBe('/operations');
    const q = query(url);
    expect(q.get('tab')).toBe('accepted');
    expect(q.get('dfrom')).toBe('2026-11-01');
    expect(q.get('feature')).toBe('transit');
    expect(q.get('page')).toBe('2');
  });

  it('without memory the menu leads to the fallback', () => {
    expect(sectionUrl('/stats')).toBe('/stats');
    expect(sectionUrl('/operations', '/operations?type=delivery')).toBe(
      '/operations?type=delivery',
    );
  });

  it('remembers the last tab of a tabbed section', () => {
    recordListUrl('/references/sites', '?q=мира');
    recordListUrl('/references/supplier-orders', '?status=approved&page=3');

    expect(sectionUrl('/references')).toBe('/references/supplier-orders?status=approved&page=3');
    expect(pageUrl('/references/sites')).toBe('/references/sites?q=%D0%BC%D0%B8%D1%80%D0%B0');
  });

  it('does not record while an operation card is open', () => {
    recordListUrl('/operations', '?type=shipment&tab=accepted&status=shipped');
    recordListUrl('/operations', '?type=delivery&delivery=abc&from=materials');
    recordListUrl('/operations', '?type=delivery&delivery=abc&new=1');

    expect(query(sectionUrl('/operations')).get('status')).toBe('shipped');
    expect(query(sectionUrl('/operations')).has('delivery')).toBe(false);
  });

  it('ignores pages outside the menu sections', () => {
    recordListUrl('/kpp', '?delivery=abc');
    recordListUrl('/settings', '?x=1');
    expect(sectionUrl('/settings')).toBe('/settings');
  });

  it("does not hand one user's filters to another", () => {
    recordListUrl('/materials', '?q=цемент');
    login(USER_B);
    expect(pageUrl('/materials')).toBe('/materials');
    // И не наследует их при записи: память перезаписывается целиком.
    recordListUrl('/stats', '?dfrom=2026-11-01');
    login(USER_A);
    expect(pageUrl('/materials')).toBe('/materials');
  });

  it('falls back to bare paths when the storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    expect(() => recordListUrl('/materials', '?q=x')).not.toThrow();
    expect(pageUrl('/materials')).toBe('/materials');
    expect(sectionUrl('/operations')).toBe('/operations');
  });

  it('ignores a stored address outside its section', () => {
    sessionStorage.setItem(
      'matcheck.list-memory.v1',
      JSON.stringify({
        userId: USER_A,
        byPath: {},
        lastInSection: { '/operations': '//evil.test/x' },
        opsTabs: {},
      }),
    );
    expect(sectionUrl('/operations')).toBe('/operations');
  });

  describe('shared site/contractor/supplier', () => {
    it('the latest choice wins over what the section remembered', () => {
      recordListUrl('/documents', '?site=old-site&q=УПД&page=4');
      useGlobalFiltersStore.getState().set({ siteIds: ['new-site'] });

      const q = query(sectionUrl('/documents'));
      expect(q.get('site')).toBe('new-site');
      expect(q.get('q')).toBe('УПД');
      // Другая выдача — со старой страницы можно попасть в пустоту.
      expect(q.has('page')).toBe(false);
    });

    it('clearing in another section clears here too', () => {
      recordListUrl('/operations', '?type=delivery&site=s1&contractor=c1&page=2');
      useGlobalFiltersStore.getState().set({ siteIds: [], contractorIds: ['c1'] });

      const q = query(sectionUrl('/operations'));
      expect(q.has('site')).toBe(false);
      expect(q.get('contractor')).toBe('c1');
      expect(q.has('page')).toBe(false);
    });

    it('keeps the page when the shared filters did not change', () => {
      useGlobalFiltersStore.getState().set({ siteIds: ['s1'] });
      recordListUrl('/operations', '?type=delivery&tab=accepted&site=s1&page=3');
      expect(query(sectionUrl('/operations')).get('page')).toBe('3');
    });

    it('History gets site and contractor but never a supplier', () => {
      useGlobalFiltersStore.getState().set({ siteIds: ['s1'], supplierIds: ['p1'] });
      const q = query(pageUrl('/materials'));
      expect(q.get('site')).toBe('s1');
      expect(q.has('supplier')).toBe(false);
    });

    it('does not touch pages with their own single-site filter', () => {
      recordListUrl('/references/supplier-orders', '?site=own');
      useGlobalFiltersStore.getState().set({ siteIds: ['shared'] });
      expect(query(pageUrl('/references/supplier-orders')).get('site')).toBe('own');
      expect(query(sectionUrl('/stats', '/stats')).has('site')).toBe(false);
    });
  });

  describe('pageUrl patch', () => {
    it('applies the patch and drops the page when something changed', () => {
      recordListUrl('/documents', '?q=акт&page=5');
      const q = query(pageUrl('/documents', { direction: 'outbound' }));
      expect(q.get('direction')).toBe('outbound');
      expect(q.get('q')).toBe('акт');
      expect(q.has('page')).toBe(false);
    });

    it('keeps the page when the patch matches what is remembered', () => {
      recordListUrl('/documents', '?q=акт&page=5');
      const q = query(pageUrl('/documents', { direction: null }));
      expect(q.get('page')).toBe('5');
    });
  });

  describe('operations tabs', () => {
    it('restores per-tab status, id, page and every purpose value', () => {
      recordListUrl(
        '/operations',
        '?type=shipment&tab=accepted&status=shipped&purpose=a&purpose=b&page=3',
      );
      recordListUrl('/operations', '?type=delivery&tab=expected&dfrom=2026-11-01');

      const params = new URLSearchParams('type=delivery&tab=expected&dfrom=2026-11-01&page=2');
      params.set('type', 'shipment');
      params.set('tab', 'accepted');
      applyOperationsTabMemory(params, { type: 'shipment', tab: 'accepted' });

      expect(params.get('status')).toBe('shipped');
      expect(params.getAll('purpose')).toEqual(['a', 'b']);
      expect(params.get('page')).toBe('3');
      expect(params.get('dfrom')).toBe('2026-11-01');
    });

    it('without memory the tab-specific params are simply dropped', () => {
      const params = new URLSearchParams('status=filled&id=12&page=4&site=s1');
      applyOperationsTabMemory(params, { type: 'delivery', tab: 'accepted' });
      expect(params.toString()).toBe('site=s1');
    });
  });

  describe('operationCardUrl', () => {
    it('opens the card on top of the remembered operations list', () => {
      recordListUrl('/operations', '?type=delivery&tab=accepted&dfrom=2026-11-01&status=filled');
      const q = query(operationCardUrl('delivery', 'd1', 'materials'));
      expect(q.get('delivery')).toBe('d1');
      expect(q.get('from')).toBe('materials');
      expect(q.get('dfrom')).toBe('2026-11-01');
      expect(q.get('status')).toBe('filled');
    });

    it('switching the type swaps the tab-specific params', () => {
      recordListUrl(
        '/operations',
        '?type=delivery&tab=accepted&status=filled&id=7&dfrom=2026-11-01',
      );
      const q = query(operationCardUrl('shipment', 's1', 'list'));
      expect(q.get('type')).toBe('shipment');
      expect(q.get('shipment')).toBe('s1');
      expect(q.has('status')).toBe(false);
      expect(q.has('id')).toBe(false);
      expect(q.get('dfrom')).toBe('2026-11-01');
    });

    it('does not let the opened card overwrite the list memory', () => {
      recordListUrl('/operations', '?type=delivery&tab=accepted&feature=transit');
      const card = operationCardUrl('delivery', 'd1', 'materials');
      recordListUrl(path(card), `?${query(card).toString()}`);
      expect(query(sectionUrl('/operations')).get('feature')).toBe('transit');
      expect(query(sectionUrl('/operations')).has('delivery')).toBe(false);
    });
  });
});
