import { useEffect, useRef } from 'react';
import { RouterProvider } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { ConfigProvider, App as AntApp } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import { router } from './app/router';
import { QueryProvider } from './app/providers/QueryProvider';
import { AuthProvider } from './app/providers/AuthProvider';
import { useQueryClient } from '@tanstack/react-query';
import { setupInvalidation } from './services/invalidation';
import { startSyncLoop } from './services/sync';
import { useAuthStore } from './stores/auth';
import { UpdateBanner } from './shared/ui/UpdateBanner';

dayjs.locale('ru');

function SideEffects() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  // Запоминаем id предыдущего юзера. При смене (logout/login/expireSession
  // в одной вкладке) полностью сбрасываем React Query кэш — иначе данные
  // одного аккаунта могут «протечь» к следующему через закэшированные
  // ответы. См. отчёт от 2026-06-16 (Firefox показывал одни и те же 3
  // вместо 22 для разных пользователей).
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const currentId = user?.id ?? null;
    if (prevUserIdRef.current !== currentId) {
      // При самом первом монтировании prev = null, current = null или
      // первый user.id — qc.clear() безопасен (пустой кэш). При смене
      // user.id или logout (id → null) кэш гарантированно чистый.
      qc.clear();
      prevUserIdRef.current = currentId;
    }
    // Только id (UUID, не ПДн) — чтобы видеть, чья сессия словила ошибку.
    Sentry.setUser(user ? { id: user.id } : null);
    if (!user) return;
    const teardownInv = setupInvalidation(qc);
    const teardownSync = startSyncLoop();
    return () => {
      teardownInv();
      teardownSync();
    };
  }, [qc, user]);
  return null;
}

export function App() {
  return (
    <ConfigProvider
      locale={ruRU}
      theme={{
        token: { colorPrimary: '#1677ff', borderRadius: 8, colorBgLayout: '#f5f5f5' },
      }}
    >
      <AntApp>
        <Sentry.ErrorBoundary
          fallback={
            <div style={{ padding: 24 }}>Произошла ошибка интерфейса. Обновите страницу.</div>
          }
        >
          <QueryProvider>
            <AuthProvider>
              <SideEffects />
              <RouterProvider router={router} />
              {/* PWA-баннер обновления. Внутри useRegisterSW (vite-plugin-pwa)
                  и фиксированной позиции снизу-центра. Появляется только при
                  реальном обнаружении нового SW; обычный первый load — null. */}
              <UpdateBanner />
            </AuthProvider>
          </QueryProvider>
        </Sentry.ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}
