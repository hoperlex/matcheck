// @vitest-environment jsdom
/**
 * Загрузка страницы при недоступном сервере не должна выглядеть как разлогин.
 *
 * На деплое 22.10 API ~2,5 минуты не отвечал. Открытые вкладки это пережили, а
 * перезагруженные (F5, новая вкладка, баннер «Доступна новая версия») ушли на
 * /login: bootstrap считал любой неуспех refresh отсутствием сессии, хотя
 * сессия была жива и cookie валидна. «Сессии нет» — только явный 401.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import type { RefreshResult } from '../../services/authRefresh';
import type * as ApiModule from '../../services/api';

const mocks = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(),
  apiGet: vi.fn(),
  syncPermissions: vi.fn(),
}));

vi.mock('../../services/authRefresh', () => ({ refreshAccessToken: mocks.refreshAccessToken }));
vi.mock('../../services/permissionsSync', () => ({ syncPermissions: mocks.syncPermissions }));
vi.mock('../../services/authScheduler', () => ({}));
vi.mock('../../services/permissionsScheduler', () => ({}));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

const { AuthProvider } = await import('./AuthProvider');
const { ApiError } = await import('../../services/api');
const { useAuthStore } = await import('../../stores/auth');

const USER = { id: 'u1', email: 'monitor@example.com', role: 'monitor' } as UserDto;
const OK: RefreshResult = { ok: true, accessToken: 'access-1' };
const DEAD: RefreshResult = { ok: false, sessionDead: true, reason: 'unauthorized' };
const SERVER_DOWN: RefreshResult = { ok: false, sessionDead: false, reason: 'server' };

const UNAVAILABLE = 'Нет связи с сервером';

function renderProvider() {
  return render(
    <AuthProvider>
      <div>портал</div>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.syncPermissions.mockResolvedValue(undefined);
  useAuthStore.getState().clear();
  window.history.replaceState(null, '', '/operations');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AuthProvider bootstrap', () => {
  it('сессия жива — портал с пользователем', async () => {
    mocks.refreshAccessToken.mockResolvedValue(OK);
    mocks.apiGet.mockResolvedValue(USER);

    renderProvider();

    await screen.findByText('портал');
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(mocks.apiGet).toHaveBeenCalledWith('/auth/me');
  });

  it('401 от refresh — сессии нет: без экрана переподключения и без повторов', async () => {
    mocks.refreshAccessToken.mockResolvedValue(DEAD);

    renderProvider();

    await screen.findByText('портал');
    expect(useAuthStore.getState().user).toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('сервер не ответил на refresh — переподключение, а не вход; по таймеру входит сам', async () => {
    // findBy/waitFor из RTL ждут через setTimeout(0) — с поддельными таймерами
    // они виснут, поэтому здесь время двигаем сами и проверяем синхронно.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.refreshAccessToken.mockResolvedValueOnce(SERVER_DOWN).mockResolvedValue(OK);
    mocks.apiGet.mockResolvedValue(USER);

    renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
    expect(screen.getByText(/входить заново не нужно/)).toBeTruthy();
    expect(screen.queryByText('портал')).toBeNull();

    // До первой ступени паузы повтора нет.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_900);
    });
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText('портал')).toBeTruthy();
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('refresh прошёл, /auth/me получил 502 — переподключение', async () => {
    mocks.refreshAccessToken.mockResolvedValue(OK);
    mocks.apiGet.mockRejectedValue(new ApiError(502, 'http_error', 'HTTP 502'));

    renderProvider();

    await screen.findByText(UNAVAILABLE);
    expect(screen.queryByText('портал')).toBeNull();
  });

  it('/auth/me получил 401 — сессии нет, без повторов', async () => {
    mocks.refreshAccessToken.mockResolvedValue(OK);
    mocks.apiGet.mockRejectedValue(new ApiError(401, 'unauthorized', 'Session expired'));

    renderProvider();

    await screen.findByText('портал');
    expect(useAuthStore.getState().user).toBeNull();
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('«Повторить сейчас» — попытка сразу, не дожидаясь таймера', async () => {
    mocks.refreshAccessToken.mockResolvedValueOnce(SERVER_DOWN).mockResolvedValue(OK);
    mocks.apiGet.mockResolvedValue(USER);

    renderProvider();

    await screen.findByText(UNAVAILABLE);
    fireEvent.click(screen.getByRole('button', { name: /Повторить сейчас/ }));

    await screen.findByText('портал');
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  it('публичная страница — bootstrap не запускается', async () => {
    window.history.replaceState(null, '', '/share/abc');

    renderProvider();

    expect(screen.getByText('портал')).toBeTruthy();
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });
});
