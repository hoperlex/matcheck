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
//
// Таймаут (единый AbortController на ожидание лока И на fetch): без него зависший
// refresh держал бы Web Lock вечно и блокировал refresh во всех вкладках. По
// таймауту — reason:'timeout', sessionDead:false: сессию НЕ убиваем, реактивный
// слой повторит. Ручной AbortController (не AbortSignal.timeout/any): целевой
// клиент — Safari, где AbortSignal.any только с 17.4.

import * as Sentry from '@sentry/react';

const REFRESH_URL = '/api/v1/auth/refresh';
const LOCK_NAME = 'matcheck-auth-refresh';
const REFRESH_TIMEOUT_MS = 10_000;

// Таймаут refresh — редкий и раньше проявлялся вечным спиннером без следа.
// Событие делает следующий инцидент видимым в Sentry, а не только в DevTools.
// stage различает: fetch завис / не дождались чужого Web Lock. No-op без DSN.
function reportRefreshTimeout(stage: 'fetch' | 'lock-wait'): void {
  Sentry.captureMessage('auth_refresh_timeout', {
    level: 'warning',
    tags: { area: 'auth', stage },
  });
}

// Дискриминированный union — вызывающий различает причину неудачи:
//  - sessionDead:true (reason:'unauthorized') — сервер явно сказал «сессия
//    мертва» (401 от /auth/refresh) → пользователя разлогинить;
//  - sessionDead:false (timeout/network/rate_limit/server/invalid_response) —
//    транзиент: refresh-cookie ещё валидна, разлогинивать НЕЛЬЗЯ.
export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; sessionDead: true; reason: 'unauthorized' }
  | {
      ok: false;
      sessionDead: false;
      reason: 'timeout' | 'network' | 'rate_limit' | 'server' | 'invalid_response';
    };

let inFlight: Promise<RefreshResult> | null = null;

async function doNetworkRefresh(signal: AbortSignal): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include', signal });
  } catch (err) {
    // Abort (таймаут) отличаем от прочих сетевых сбоев — оба транзиентны.
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    if (aborted) reportRefreshTimeout('fetch');
    return { ok: false, sessionDead: false, reason: aborted ? 'timeout' : 'network' };
  }
  if (res.ok) {
    try {
      const { accessToken } = (await res.json()) as { accessToken: string };
      if (accessToken) return { ok: true, accessToken };
    } catch {
      /* тело не распарсилось */
    }
    return { ok: false, sessionDead: false, reason: 'invalid_response' };
  }
  // 401 → сессия действительно мертва; 429 → лимит; прочее (5xx и т.п.) → server.
  if (res.status === 401) return { ok: false, sessionDead: true, reason: 'unauthorized' };
  if (res.status === 429) return { ok: false, sessionDead: false, reason: 'rate_limit' };
  return { ok: false, sessionDead: false, reason: 'server' };
}

async function refreshUnderLock(): Promise<RefreshResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    // navigator.locks есть во всех современных Chromium/Firefox/Safari 15.4+.
    // signal прерывает И ожидание лока (чужая вкладка зависла), И сам fetch.
    // Fallback (без блокировки) сохраняет single-flight внутри вкладки.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return await navigator.locks.request(
        LOCK_NAME,
        { mode: 'exclusive', signal: controller.signal },
        () => doNetworkRefresh(controller.signal),
      );
    }
    return await doNetworkRefresh(controller.signal);
  } catch {
    // AbortError от locks.request (не дождались лока за таймаут) — транзиент.
    reportRefreshTimeout('lock-wait');
    return { ok: false, sessionDead: false, reason: 'timeout' };
  } finally {
    clearTimeout(timer);
  }
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
