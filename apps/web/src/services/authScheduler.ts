import { useAuthStore } from '../stores/auth';
import { refreshAccessToken } from './authRefresh';

// Обновляем access JWT за 60с до истечения. Это убирает 401 на интервал-driven
// запросах (sync, focus-refetch react-query): к моменту истечения у клиента
// уже лежит свежий токен. Реактивный refresh в api.ts остаётся как safety net.
const SKEW_MS = 60_000;

// Транзиентная осечка refresh (сеть моргнула, 429, 5xx) НЕ должна разлогинивать —
// refresh-cookie ещё валидна. Вместо expireSession планируем короткий ретрай с
// backoff; если и он не помог — тихо сдаёмся, реактивный 401 в api.ts подхватит.
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000];

let timer: number | null = null;
let retryCount = 0;

function parseExpMs(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function attemptRefresh(): Promise<void> {
  timer = null;
  const r = await refreshAccessToken();
  if (r.ok) {
    retryCount = 0;
    // setAccessToken → подписка ниже перепланирует на новый exp.
    useAuthStore.getState().setAccessToken(r.accessToken);
    return;
  }
  if (r.sessionDead) {
    // Сервер явно сказал «сессия мертва» (401 от /auth/refresh) — только тут выходим.
    retryCount = 0;
    useAuthStore.getState().expireSession();
    return;
  }
  // Транзиент: сессию не трогаем, планируем ретрай.
  if (retryCount < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[retryCount] ?? 60_000;
    retryCount += 1;
    timer = window.setTimeout(() => void attemptRefresh(), delay);
  } else {
    retryCount = 0;
  }
}

export function schedulePreemptiveRefresh(): void {
  cancelPreemptiveRefresh();
  const token = useAuthStore.getState().accessToken;
  if (!token) return;
  const expMs = parseExpMs(token);
  if (!expMs) return;
  const delay = Math.max(0, expMs - Date.now() - SKEW_MS);
  timer = window.setTimeout(() => void attemptRefresh(), delay);
}

export function cancelPreemptiveRefresh(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  retryCount = 0;
}

// Авто-перепланирование при каждом изменении токена в store. Подписка
// активируется при первом импорте модуля; импорт делается в AuthProvider.tsx.
let prevToken: string | null = useAuthStore.getState().accessToken;
useAuthStore.subscribe((state) => {
  if (state.accessToken === prevToken) return;
  prevToken = state.accessToken;
  if (state.accessToken) schedulePreemptiveRefresh();
  else cancelPreemptiveRefresh();
});

// Если модуль импортирован уже после bootstrap (токен уже в store) —
// запланировать сразу.
if (prevToken) schedulePreemptiveRefresh();
