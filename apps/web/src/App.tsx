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
import { startSyncLoop, syncAvailableForRole } from './services/sync';
import { useAuthStore } from './stores/auth';
import { UpdateBanner } from './shared/ui/UpdateBanner';
import { MismatchRowStyle } from './shared/ui/MismatchRowStyle';

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
    // Офлайн-синхронизация есть не у всех ролей: contractor и monitor получают
    // на /api/v1/sync 403. Раньше цикл стартовал для любого залогиненного и раз
    // в минуту стучался в закрытую дверь.
    const teardownSync = syncAvailableForRole(user.role) ? startSyncLoop() : undefined;
    return () => {
      teardownInv();
      teardownSync?.();
    };
  }, [qc, user]);
  return null;
}

export function App() {
  return (
    <>
      <MismatchRowStyle />
      <ConfigProvider
        locale={ruRU}
        theme={{
          token: { colorPrimary: '#1677ff', borderRadius: 8, colorBgLayout: '#f5f5f5' },
          components: {
            // Плотные таблицы: на 1080p помещается ~24 строки вместо 17.
            // Шрифт ячеек 13px против базовых 14 — плотнее, но всё ещё крупнее
            // тегов (12px), так что иерархия «текст ячейки > тег» сохраняется.
            // Дефолты antd, которые здесь перекрываются: cellPaddingBlock = 16,
            // …MD = 12, …SM = 8; все три cellFontSize* равны 14 — size="small"
            // сам по себе шрифт НЕ уменьшает, только отступы.
            Table: {
              cellFontSize: 13,
              cellFontSizeMD: 13,
              cellFontSizeSM: 13,
              cellPaddingBlock: 6,
              cellPaddingBlockMD: 6,
              cellPaddingBlockSM: 6,
              cellPaddingInlineMD: 8,
              cellPaddingInlineSM: 8,
            },
          },
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
    </>
  );
}
