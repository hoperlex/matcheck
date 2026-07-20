// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// authRefresh держит модульный inFlight — между сценариями обязателен
// resetModules + повторный dynamic import, иначе single-flight «протекает».
async function loadModule() {
  vi.resetModules();
  return import('./authRefresh');
}

// Мок navigator.locks: exclusive-лок в тесте = просто выполнить callback.
// stubGlobal — navigator в Node readonly, прямое присваивание падает.
function installLocks(): void {
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb(),
    },
  });
}

describe('refreshAccessToken', () => {
  beforeEach(() => {
    installLocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('успех: возвращает accessToken', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: 'AT' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { refreshAccessToken } = await loadModule();

    const r = await refreshAccessToken();
    expect(r).toEqual({ ok: true, accessToken: 'AT' });
  });

  it('КРИТИЧНО: 401 → sessionDead:true (разлогин), reason unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    const { refreshAccessToken } = await loadModule();

    const r = await refreshAccessToken();
    expect(r).toEqual({ ok: false, sessionDead: true, reason: 'unauthorized' });
  });

  it('КРИТИЧНО: сетевой сбой → sessionDead:false (НЕ разлогинивать)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const { refreshAccessToken } = await loadModule();

    const r = await refreshAccessToken();
    expect(r).toEqual({ ok: false, sessionDead: false, reason: 'network' });
  });

  it('КРИТИЧНО: abort (таймаут) → sessionDead:false, reason timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const { refreshAccessToken } = await loadModule();

    const r = await refreshAccessToken();
    expect(r).toEqual({ ok: false, sessionDead: false, reason: 'timeout' });
  });

  it('429 → rate_limit (транзиент); 5xx → server (транзиент)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429 })),
    );
    let m = await loadModule();
    expect(await m.refreshAccessToken()).toMatchObject({
      sessionDead: false,
      reason: 'rate_limit',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    m = await loadModule();
    expect(await m.refreshAccessToken()).toMatchObject({ sessionDead: false, reason: 'server' });
  });

  it('200 без accessToken → invalid_response (транзиент, не разлогин)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const { refreshAccessToken } = await loadModule();
    expect(await refreshAccessToken()).toEqual({
      ok: false,
      sessionDead: false,
      reason: 'invalid_response',
    });
  });

  it('КРИТИЧНО (reuse-detection): N конкурентных вызовов → РОВНО ОДИН сетевой refresh', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ accessToken: 'AT' }), { status: 200 });
      }),
    );
    const { refreshAccessToken } = await loadModule();

    const results = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);

    expect(calls).toBe(1);
    for (const r of results) expect(r).toEqual({ ok: true, accessToken: 'AT' });
  });

  it('inFlight сбрасывается: после завершения новый вызов делает новый refresh', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: 'AT' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { refreshAccessToken } = await loadModule();

    await refreshAccessToken();
    await refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
