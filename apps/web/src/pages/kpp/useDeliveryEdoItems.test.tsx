// @vitest-environment jsdom
/**
 * Строки УПД из ЭДО по привязкам приёмки — запрос на каждую привязку.
 *
 * Обещания: медленная или сбойная УПД не мешает соседней; новая привязка
 * дочитывается сама, остальные не перечитываются; при «Повторить» уже
 * показанные строки не пропадают.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { LinkedEdoDocument } from './LinkedEdoChips';

const get = vi.fn();
vi.mock('../../services/api', () => ({ api: { get } }));

const { useDeliveryEdoItems } = await import('./useDeliveryEdoItems');

const match = (id: string): LinkedEdoDocument => ({
  id,
  documentId: `reg-${id}`,
  source: 'export',
  docNumber: id,
  docDate: null,
  supplierName: null,
  supplierInn: null,
  totalSum: null,
  linkedAt: '2026-10-26T10:00:00Z',
  sectionDocumentId: null,
  alsoIn: [],
  alsoInCount: 0,
  operator: 'sbis',
});

const response = (matchId: string) => ({
  matchId,
  source: 'export',
  label: { operator: 'sbis', docNumber: matchId, docDate: null, correctionNumber: null },
  state: 'ready',
  totals: { totalSum: 1, totalExVat: 1, vatSum: 0 },
  reasons: [],
  items: [],
});

const path = (matchId: string) => `/deliveries/d1/edo-matches/${matchId}/items`;

function setup(initial: LinkedEdoDocument[]) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ matches }) => useDeliveryEdoItems('d1', matches), {
    wrapper,
    initialProps: { matches: initial },
  });
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('useDeliveryEdoItems', () => {
  it('у каждой УПД своё состояние: готова, ещё грузится, не дошла', async () => {
    get.mockImplementation((url: string) => {
      if (url === path('fast')) return Promise.resolve(response('fast'));
      if (url === path('slow')) return new Promise(() => undefined);
      return Promise.reject(new Error('502'));
    });
    const { result } = setup([match('fast'), match('slow'), match('broken')]);

    await waitFor(() => expect(result.current.get('fast')?.status).toBe('done'));
    await waitFor(() => expect(result.current.get('broken')?.status).toBe('error'));
    expect(result.current.get('slow')?.status).toBe('loading');
    expect(result.current.get('fast')?.data?.matchId).toBe('fast');
  });

  it('новая привязка дочитывается сама, прочие не перечитываются', async () => {
    get.mockImplementation((url: string) => Promise.resolve(response(url.split('/')[4]!)));
    const { result, rerender } = setup([match('a')]);
    await waitFor(() => expect(result.current.get('a')?.status).toBe('done'));

    rerender({ matches: [match('a'), match('b')] });
    await waitFor(() => expect(result.current.get('b')?.status).toBe('done'));
    expect(get.mock.calls.map(([url]) => url)).toEqual([path('a'), path('b')]);
  });

  it('«Повторить» не прячет уже показанные строки, а сбой без данных — повторяется', async () => {
    let calls = 0;
    get.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('502')) : Promise.resolve(response('a'));
    });
    const { result } = setup([match('a')]);
    await waitFor(() => expect(result.current.get('a')?.status).toBe('error'));

    act(() => result.current.get('a')!.refetch());
    await waitFor(() => expect(result.current.get('a')?.status).toBe('done'));

    // Повтор при готовых данных: пока ответа нет, статус остаётся «готово».
    get.mockImplementation(() => new Promise(() => undefined));
    act(() => result.current.get('a')!.refetch());
    expect(result.current.get('a')?.status).toBe('done');
    expect(result.current.get('a')?.data?.matchId).toBe('a');
  });

  it('без привязок — ни одного запроса', () => {
    const { result } = setup([]);
    expect(result.current.size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });
});
