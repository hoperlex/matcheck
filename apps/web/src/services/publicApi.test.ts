// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PublicApiError,
  publicGetSites,
  publicGetUploadStatus,
  publicUploadDocuments,
} from './publicApi';

/**
 * Публичный клиент обязан оставаться анонимным.
 *
 * Если он однажды начнёт ходить через общий api.ts, поставщик получит попытку
 * refresh на 401, а случайно залогиненный в той же вкладке менеджер — риск
 * разлогина. Тест фиксирует именно это: ни Authorization, ни cookie.
 */
function lastCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init: init ?? {} };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publicApi', () => {
  it('не шлёт Authorization и не отправляет cookie', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await publicGetSites();

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('/api/v1/public/sites');
    expect(init.credentials).toBe('omit');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it('HTML-ответ от nginx превращается в понятную ошибку, а не в SyntaxError', async () => {
    // 413 от nginx приходит мимо API — телом будет HTML-страница.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>413 Request Entity Too Large</body></html>', {
            status: 413,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    await expect(
      publicUploadDocuments([], {
        siteId: 's',
        expectedDate: '2026-08-10',
        comment: '',
        website: '',
      }),
    ).rejects.toMatchObject({
      name: 'PublicApiError',
      status: 413,
      code: 'payload_too_large',
    });
  });

  it('не-JSON ответ (502 при перезапуске) не роняет страницу', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>502</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    await expect(publicGetSites()).rejects.toBeInstanceOf(PublicApiError);
  });

  it('ошибку API отдаёт с её текстом — его показывают поставщику', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: 'cross_scope', message: 'Эти же файлы уже загружены на другой объект' },
          409,
        ),
      ),
    );

    await expect(
      publicUploadDocuments([], {
        siteId: 's',
        expectedDate: '2026-08-10',
        comment: '',
        website: '',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'cross_scope',
      message: 'Эти же файлы уже загружены на другой объект',
    });
  });

  it('тикет в URL статуса экранируется', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ticket: 'a/b',
        status: 'processing',
        filesTotal: 0,
        filesAccepted: 0,
        files: [],
        submittedAt: '2026-08-05T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await publicGetUploadStatus('a/b');

    expect(lastCall(fetchMock).url).toBe('/api/v1/public/upload-documents/a%2Fb');
  });
});
