// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_MATRIX, type MePermissionsResponse } from '@matcheck/contracts';

// Модуль держит модульный inFlight — между сценариями обязателен
// resetModules + повторный dynamic import, иначе single-flight «протекает».
async function loadModule() {
  vi.resetModules();
  return import('./permissionsSync');
}

const response = (over: Partial<MePermissionsResponse> = {}): MePermissionsResponse =>
  ({
    userId: 'u1',
    role: 'manager',
    enforced: true,
    pages: {},
    ...over,
  }) as MePermissionsResponse;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('permissionsToApply: чей это ответ', () => {
  it('ответ про другого пользователя НЕ применяется', async () => {
    // Самый неприятный сценарий фичи: он не падает и ничего не логирует —
    // человек просто видит чужое меню. Запрос стартовал под одним
    // пользователем (разлогин + вход в соседней вкладке), завершился под другим.
    const { permissionsToApply } = await loadModule();
    expect(permissionsToApply(response({ userId: 'old' }), null, { id: 'new' })).toBeNull();
  });

  it('ответ не тому, кому запрашивали, тоже отбрасывается', async () => {
    const { permissionsToApply } = await loadModule();
    // payload.userId совпал со стором, но запрос делался для другого — значит
    // стор успел смениться дважды, доверять нечему.
    expect(permissionsToApply(response({ userId: 'u1' }), { id: 'u2' }, { id: 'u1' })).toBeNull();
  });

  it('после выхода не применяется ничего', async () => {
    const { permissionsToApply } = await loadModule();
    expect(permissionsToApply(response(), { id: 'u1' }, null)).toBeNull();
  });

  it('свой ответ применяется и разбирается в набор прав', async () => {
    const { permissionsToApply } = await loadModule();
    const perms = permissionsToApply(response(), { id: 'u1' }, { id: 'u1' });
    expect(perms).not.toBeNull();
    expect(perms!.role).toBe('manager');
    expect(perms!.pages['references.sites']).toEqual(DEFAULT_MATRIX.manager['references.sites']);
  });
});

describe('fetchPermissions: сеть', () => {
  it('успех отдаёт payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response()), { status: 200 })),
    );
    const { fetchPermissions } = await loadModule();
    const r = await fetchPermissions();
    expect(r).toEqual({ ok: true, payload: response() });
  });

  it('404 (старый API без маршрута) — не отказ в правах, а «не знаем»', async () => {
    // Веб выкатили раньше API. Вызывающий останется на дефолтах роли.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    const { fetchPermissions } = await loadModule();
    expect(await fetchPermissions()).toEqual({ ok: false, reason: 'server' });
  });

  it('сетевой сбой не бросает исключение', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    const { fetchPermissions } = await loadModule();
    expect(await fetchPermissions()).toEqual({ ok: false, reason: 'network' });
  });

  it('битое тело отбраковывается', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 })),
    );
    const { fetchPermissions } = await loadModule();
    expect(await fetchPermissions()).toEqual({ ok: false, reason: 'invalid_response' });
  });

  it('single-flight: три одновременных вызова — один запрос', async () => {
    // Polling, focus и ре-синк после 403 сходятся легко; трёх запросов на одно
    // событие быть не должно.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(response()), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchPermissions } = await loadModule();

    await Promise.all([fetchPermissions(), fetchPermissions(), fetchPermissions()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Следующий вызов после завершения — уже новый запрос.
    await fetchPermissions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
