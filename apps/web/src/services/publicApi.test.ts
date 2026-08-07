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
    // Пример намеренно из тех отказов, что реально доходят до поставщика.
    // Раньше здесь стоял cross_scope, но его больше нет: тот же комплект на
    // другой объект или дату теперь принимается и становится своим пакетом.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: 's3_unavailable',
            message: 'Хранилище временно недоступно. Попробуйте отправить документы ещё раз.',
          },
          503,
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
      status: 503,
      code: 's3_unavailable',
      message: 'Хранилище временно недоступно. Попробуйте отправить документы ещё раз.',
    });
  });

  it('файлы второй зоны уезжают под именем extraFiles', async () => {
    // Режим обработки едет ИМЕНЕМ части: текстовые поля сервер читает раньше
    // файлов, поэтому пофайловый признак отдельным полем не выразить.
    const fetchMock = vi.fn(async () => jsonResponse({ ticket: 't', accepted: 2, rejected: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await publicUploadDocuments(
      [new File(['upd'], 'upd.pdf', { type: 'application/pdf' })],
      { siteId: 's', expectedDate: '2026-08-10', comment: '', website: '' },
      [new File(['cert'], 'cert.pdf', { type: 'application/pdf' })],
    );

    const form = lastCall(fetchMock).init.body as FormData;
    expect(form.getAll('files').map((f) => (f as File).name)).toEqual(['upd.pdf']);
    expect(form.getAll('extraFiles').map((f) => (f as File).name)).toEqual(['cert.pdf']);
  });

  it('без второй зоны запрос остаётся прежним', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ticket: 't', accepted: 1, rejected: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await publicUploadDocuments([new File(['upd'], 'upd.pdf')], {
      siteId: 's',
      expectedDate: '2026-08-10',
      comment: '',
      website: '',
    });

    const form = lastCall(fetchMock).init.body as FormData;
    expect(form.getAll('extraFiles')).toEqual([]);
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
