import { useEffect, useState, type ReactNode } from 'react';
import { Button, Result } from 'antd';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, ApiError } from '../../services/api';
import { refreshAccessToken } from '../../services/authRefresh';
import { syncPermissions } from '../../services/permissionsSync';
// Импорт активирует подписку на store: при появлении/смене access-токена
// планируется проактивный refresh за 60с до истечения. Без этого 401 на
// интервал-driven запросах (sync, focus-refetch) копятся в DevTools.
import '../../services/authScheduler';
// Аналогично для прав: подписка на смену пользователя (загрузить/очистить),
// polling, обновление по focus и после 403.
import '../../services/permissionsScheduler';

/**
 * Страницы, которые работают без логина.
 *
 * На них bootstrap не нужен и вреден: POST /auth/refresh без cookie всё равно
 * вернёт 401, а до его завершения провайдер рендерит null — на медленной
 * мобильной сети поставщик несколько секунд смотрит на белый экран.
 */
const PUBLIC_PATH_PREFIXES = ['/share/', '/uploads'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/**
 * Паузы между повторами, когда сервер не ответил при загрузке страницы; после
 * последней — она же, пока сервер не вернётся. Все короче серверного
 * grace-окна refresh (REFRESH_REUSE_GRACE_SECONDS, 60 с): если ответ прошлой
 * попытки потерялся, повтор со старой cookie сервер примет как replay, а не
 * как кражу токена.
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000] as const;
const MAX_RETRY_DELAY_MS = 15_000;

/**
 * Сервер не ответил по существу: таймаут, обрыв, 5xx, 429. Сессия при этом
 * может быть жива — разлогинивать нельзя.
 *
 * TypeError — сетевой обрыв fetch: api.ts пробрасывает его как есть. Ловится
 * он только вокруг одного запроса, поэтому с ошибкой в нашем коде не спутать.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError;
}

/**
 * loading — первая попытка в полёте; ready — исход известен (вошли или сессии
 * нет); unavailable — сервер не ответил, повторяем.
 */
type BootState = 'loading' | 'ready' | 'unavailable';

export function AuthProvider({ children }: { children: ReactNode }) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const [state, setState] = useState<BootState>(() =>
    isPublicPath(window.location.pathname) ? 'ready' : 'loading',
  );
  // Попытка в полёте — для спиннера на кнопке экрана переподключения.
  const [checking, setChecking] = useState(false);
  // Ручной повтор: смена значения перезапускает эффект — таймер снимается,
  // попытка идёт сразу, паузы снова с первой ступени.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (isPublicPath(window.location.pathname)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    // Раньше любой неуспех refresh здесь означал «не вошёл»: user оставался
    // null, и ProtectedRoute уводил на /login. Так перезагрузка страницы, пока
    // API перезапускается при деплое (nginx отдаёт 502), выкидывала человека
    // на вход при живой сессии и валидной cookie — открытые вкладки тот же
    // простой переживали. Теперь «сессии нет» — только явный 401.
    async function attemptBootstrap(): Promise<'done' | 'transient'> {
      // Через общий refreshAccessToken → под тем же Web Lock, что scheduler и
      // реактивный 401. Иначе вкладка, грузящаяся пока другая рефрешит, слала бы
      // конкурентный refresh с той же cookie → reuse-detection убил бы сессию.
      const r = await refreshAccessToken();
      if (!r.ok) return r.sessionDead ? 'done' : 'transient';
      if (cancelled) return 'done';
      setAccessToken(r.accessToken);
      let me: UserDto;
      try {
        me = await api.get<UserDto>('/auth/me');
      } catch (err) {
        // 401 сюда доходит уже после реактивного refresh в api.ts: либо сессия
        // мертва (expireSession сделан), либо транзиент со статусом 0.
        if (isTransient(err)) return 'transient';
        if (!(err instanceof ApiError)) console.warn('auth bootstrap failed', err);
        return 'done';
      }
      if (cancelled) return 'done';
      setUser(me);
      // Права — ДО снятия загрузки, иначе первый кадр рисуется по
      // дефолтам роли и меню на глазах у человека сужается. Сверку «чей
      // это ответ» делает syncPermissions: сверять со стором здесь нельзя,
      // user попадает туда только что и мог уже смениться.
      //
      // Запрос к этому моменту, скорее всего, уже в полёте — его запустила
      // подписка permissionsScheduler на смену пользователя; single-flight
      // отдаёт обоим один промис, сетевой запрос остаётся один.
      await syncPermissions(me);
      return 'done';
    }

    async function bootstrap() {
      setChecking(true);
      let outcome: 'done' | 'transient';
      try {
        outcome = await attemptBootstrap();
      } catch (err) {
        if (!(err instanceof ApiError)) {
          console.warn('auth bootstrap failed', err);
        }
        outcome = 'done';
      }
      if (cancelled) return;
      setChecking(false);
      if (outcome === 'done') {
        setState('ready');
        return;
      }
      setState('unavailable');
      const delay = RETRY_DELAYS_MS[attempt] ?? MAX_RETRY_DELAY_MS;
      attempt += 1;
      timer = setTimeout(() => void bootstrap(), delay);
    }
    void bootstrap();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [setAuth, setAccessToken, setUser, retryNonce]);

  if (state === 'loading') {
    return null;
  }
  if (state === 'unavailable') {
    return (
      <Result
        status="warning"
        title="Нет связи с сервером"
        subTitle="Возможно, идёт обновление портала. Переподключаемся автоматически — входить заново не нужно."
        extra={
          <Button type="primary" loading={checking} onClick={() => setRetryNonce((n) => n + 1)}>
            Повторить сейчас
          </Button>
        }
      />
    );
  }
  return <>{children}</>;
}
