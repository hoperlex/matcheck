import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { recordListUrl } from '../listMemory';

/**
 * Запоминает адрес каждой страницы раздела (см. shared/listMemory). Висит в
 * оболочке портала: страницам о памяти знать не нужно.
 *
 * userId в зависимостях — чтобы адрес записался и сразу после входа, когда
 * пользователь появляется уже на открытой странице.
 */
export function useListMemoryRecorder(): void {
  const { pathname, search } = useLocation();
  const userId = useAuthStore((s) => s.user?.id);
  useEffect(() => {
    if (userId) recordListUrl(pathname, search);
  }, [pathname, search, userId]);
}
