import { useEffect, useState, type ReactNode } from 'react';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, ApiError } from '../../services/api';
import { refreshAccessToken } from '../../services/authRefresh';
// Импорт активирует подписку на store: при появлении/смене access-токена
// планируется проактивный refresh за 60с до истечения. Без этого 401 на
// интервал-driven запросах (sync, focus-refetch) копятся в DevTools.
import '../../services/authScheduler';

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const [bootstrapped, setBootstrapped] = useState(() =>
    isPublicPath(window.location.pathname),
  );

  useEffect(() => {
    if (isPublicPath(window.location.pathname)) return;
    let cancelled = false;
    async function bootstrap() {
      try {
        // Через общий refreshAccessToken → под тем же Web Lock, что scheduler и
        // реактивный 401. Иначе вкладка, грузящаяся пока другая рефрешит, слала бы
        // конкурентный refresh с той же cookie → reuse-detection убил бы сессию.
        const r = await refreshAccessToken();
        if (r.ok) {
          if (cancelled) return;
          setAccessToken(r.accessToken);
          const me = await api.get<UserDto>('/auth/me');
          if (cancelled) return;
          setUser(me);
        }
      } catch (err) {
        if (!(err instanceof ApiError)) {
          console.warn('auth bootstrap failed', err);
        }
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [setAuth, setAccessToken, setUser]);

  if (!bootstrapped) {
    return null;
  }
  return <>{children}</>;
}
