// @vitest-environment node
/**
 * Жизненный цикл прав во вкладке.
 *
 * Главное здесь — выход. Права остаются в памяти вкладки, и если их не
 * стереть, следующий вошедший до ответа сервера видит меню предыдущего: не
 * ошибка, не исключение, просто чужой интерфейс на секунду-другую.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserDto } from '@matcheck/contracts';

const userA = { id: 'a1', email: 'a@test', role: 'manager', isActive: true } as UserDto;
const userB = { id: 'b2', email: 'b@test', role: 'contractor', isActive: true } as UserDto;

function stubFetchFor(user: UserDto) {
  const mock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ userId: user.id, role: user.role, enforced: true, pages: {} }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Свежие модули на каждый сценарий: и стор, и подписка модульные. */
async function loadAll() {
  vi.resetModules();
  const auth = await import('../stores/auth');
  const permissions = await import('../stores/permissions');
  await import('./permissionsScheduler');
  return { auth: auth.useAuthStore, permissions: permissions.usePermissionsStore };
}

beforeEach(() => {
  stubFetchFor(userA);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('permissionsScheduler', () => {
  it('вход грузит права текущего пользователя', async () => {
    const { auth, permissions } = await loadAll();
    auth.getState().setAuth('token', userA);
    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());

    expect(permissions.getState().userId).toBe('a1');
    expect(permissions.getState().perms!.role).toBe('manager');
  });

  it('КРИТИЧНО: выход стирает права', async () => {
    const { auth, permissions } = await loadAll();
    auth.getState().setAuth('token', userA);
    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());

    auth.getState().clear();
    expect(permissions.getState().perms).toBeNull();
    expect(permissions.getState().userId).toBeNull();
  });

  it('истёкшая сессия стирает права так же, как выход', async () => {
    const { auth, permissions } = await loadAll();
    auth.getState().setAuth('token', userA);
    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());

    auth.getState().expireSession();
    expect(permissions.getState().perms).toBeNull();
  });

  it('смена пользователя не оставляет чужих прав ни на кадр', async () => {
    const { auth, permissions } = await loadAll();
    auth.getState().setAuth('token', userA);
    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());

    // Ответ для B ещё не пришёл, но права A должны исчезнуть НЕМЕДЛЕННО.
    stubFetchFor(userB);
    auth.getState().setAuth('token2', userB);
    expect(permissions.getState().perms).toBeNull();

    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());
    expect(permissions.getState().perms!.role).toBe('contractor');
    expect(permissions.getState().userId).toBe('b2');
  });

  it('обновление токена (тот же пользователь) права не перезагружает', async () => {
    // setAccessToken срабатывает каждые ~14 минут; лишний запрос тут не нужен.
    const fetchMock = stubFetchFor(userA);
    const { auth, permissions } = await loadAll();
    auth.getState().setAuth('token', userA);
    await vi.waitFor(() => expect(permissions.getState().perms).not.toBeNull());
    const callsAfterLogin = fetchMock.mock.calls.length;

    auth.getState().setAccessToken('token-refreshed');
    expect(fetchMock.mock.calls.length).toBe(callsAfterLogin);
    expect(permissions.getState().perms).not.toBeNull();
  });
});
