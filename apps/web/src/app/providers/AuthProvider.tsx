import { useEffect, useState, type ReactNode } from 'react';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, ApiError } from '../../services/api';

export function AuthProvider({ children }: { children: ReactNode }) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);
  const setUser = useAuthStore((s) => s.setUser);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const refreshRes = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        if (refreshRes.ok) {
          const { accessToken } = (await refreshRes.json()) as { accessToken: string };
          if (cancelled) return;
          setAccessToken(accessToken);
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
