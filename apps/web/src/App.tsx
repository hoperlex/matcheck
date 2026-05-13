import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
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

dayjs.locale('ru');

function SideEffects() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (!user) return;
    const teardownInv = setupInvalidation(qc);
    const teardownSync = startSyncLoop(5 * 60 * 1000);
    return () => {
      teardownInv();
      teardownSync();
    };
  }, [qc, user]);
  return null;
}

export function App() {
  return (
    <ConfigProvider locale={ruRU} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 8 } }}>
      <AntApp>
        <QueryProvider>
          <AuthProvider>
            <SideEffects />
            <RouterProvider router={router} />
          </AuthProvider>
        </QueryProvider>
      </AntApp>
    </ConfigProvider>
  );
}
