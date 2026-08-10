// @vitest-environment node
/**
 * Оповещение об отказе по матрице прав (403 permission_denied).
 *
 * Это стык двух модулей: api.ts зовёт подписчиков, permissionsScheduler на
 * этом перезагружает права. Стык молчаливый — если api перестанет звать,
 * ничего не сломается заметно: вернувшееся право просто не появится до
 * следующего polling. Поэтому проверяем сам контракт.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadApi() {
  vi.resetModules();
  return import('./api');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('onForbidden', () => {
  it('403 permission_denied оповещает подписчиков', async () => {
    stubResponse(403, { error: 'permission_denied', message: 'Недостаточно прав' });
    const { api, onForbidden } = await loadApi();
    const seen = vi.fn();
    onForbidden(seen);

    await expect(api.get('/sites')).rejects.toThrow();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ code: 'permission_denied' });
  });

  it('403 от authorize(...) — не про матрицу, права не перечитываем', async () => {
    // Роль без доступа к маршруту вовсе (read-only guard, allow-list ролей):
    // матрица тут ни при чём, и перезагрузка прав ничего не изменит.
    stubResponse(403, { error: 'forbidden', message: 'Read-only role' });
    const { api, onForbidden } = await loadApi();
    const seen = vi.fn();
    onForbidden(seen);

    await expect(api.get('/sites')).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it('ошибка подписчика не ломает обработку ответа', async () => {
    stubResponse(403, { error: 'permission_denied', message: 'Недостаточно прав' });
    const { api, onForbidden } = await loadApi();
    onForbidden(() => {
      throw new Error('подписчик упал');
    });

    // Вызывающий обязан получить именно ApiError про отказ, а не ошибку
    // подписчика.
    await expect(api.get('/sites')).rejects.toMatchObject({
      status: 403,
      code: 'permission_denied',
    });
  });

  it('отписка работает', async () => {
    stubResponse(403, { error: 'permission_denied', message: 'Недостаточно прав' });
    const { api, onForbidden } = await loadApi();
    const seen = vi.fn();
    const off = onForbidden(seen);
    off();

    await expect(api.get('/sites')).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });
});
