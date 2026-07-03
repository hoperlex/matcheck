// Единый источник обновления access-токена для всего web-клиента.
//
// Раньше refresh дёргали три независимых механизма (bootstrap в AuthProvider,
// проактивный таймер в authScheduler, реактивный 401 в api.ts), каждый со своим
// in-flight guard. Из-за этого два refresh легко уходили с одной и той же
// refresh-cookie одновременно (сон/пробуждение ноутбука, мультивкладка), а сервер
// на каждый /auth/refresh ротирует токен и трактует повторное предъявление уже
// отозванного токена как кражу → инвалидирует ВСЮ сессию (reuse-detection) →
// пользователя выкидывает на логин.
//
// Здесь refresh сведён к одной точке:
//  - единый модульный in-flight дедупит вызовы внутри вкладки;
//  - Web Locks сериализует запрос между вкладками — вторая вкладка стартует
//    refresh только после того, как первая завершилась и её Set-Cookie применился,
//    поэтому каждый refresh видит актуальную cookie и коллизий с ротацией нет.

const REFRESH_URL = '/api/v1/auth/refresh';
const LOCK_NAME = 'matcheck-auth-refresh';

// sessionDead=true — только когда сервер явно ответил 401 (токена нет/невалиден,
// сессия мертва) → пользователя надо разлогинить. Сеть-ошибка, 429, 5xx —
// транзиент (sessionDead=false): refresh-cookie ещё валидна, разлогинивать нельзя.
export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; sessionDead: boolean };

let inFlight: Promise<RefreshResult> | null = null;

async function doNetworkRefresh(): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
  } catch {
    // Сеть недоступна — транзиент, сессию не трогаем.
    return { ok: false, sessionDead: false };
  }
  if (res.ok) {
    try {
      const { accessToken } = (await res.json()) as { accessToken: string };
      if (accessToken) return { ok: true, accessToken };
    } catch {
      /* тело не распарсилось — считаем транзиентом */
    }
    return { ok: false, sessionDead: false };
  }
  // 401 → сессия действительно мертва; 429/5xx и прочее → транзиент.
  return { ok: false, sessionDead: res.status === 401 };
}

async function refreshUnderLock(): Promise<RefreshResult> {
  // navigator.locks есть во всех современных Chromium/Firefox/Safari 15.4+.
  // Fallback (без блокировки) сохраняет single-flight внутри вкладки.
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, doNetworkRefresh);
  }
  return doNetworkRefresh();
}

/**
 * Обновить access-токен. Все вызовы, пришедшие пока запрос в полёте, получают
 * один и тот же промис (один сетевой refresh на вкладку, сериализованный между
 * вкладками через Web Locks). Стор здесь НЕ трогаем — вызывающий код сам решает,
 * что делать с результатом (setAccessToken / expireSession / ретрай).
 */
export function refreshAccessToken(): Promise<RefreshResult> {
  if (!inFlight) {
    inFlight = refreshUnderLock().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
