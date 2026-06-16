import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { OperationsCountersResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';

/**
 * Лёгкий polling-хук для двух счётчиков шапки раздела «Операции»:
 *  - completedToday — приёмки+отгрузки со status='confirmed_mol' за сегодня (МСК);
 *  - inProgress — приёмки 'filled' + отгрузки 'shipped' (1 Этап есть, 2 ещё нет).
 *
 * Опрос раз в 30 сек (как у NotificationsBell). Кэш — общий queryKey,
 * после save/delete мутаций инвалидируется по нему же — мгновенное
 * обновление, без ожидания тика polling-а.
 *
 * Включён только для залогиненных юзеров (без авторизации запрос упал бы 401).
 */
export function useOperationsCounters() {
  const userId = useAuthStore((s) => s.user?.id);
  // userId — суффиксом в queryKey, чтобы при смене пользователя в одной
  // вкладке React Query не отдавал старые данные предыдущего юзера
  // (см. отчёт от 2026-06-16: в Firefox разные аккаунты видели один
  // и тот же закэшированный ответ). Существующие invalidateQueries по
  // префиксу ['reports','operations-counters'] продолжают работать через
  // prefix-match React Query — счётчик обновляется после save/delete как
  // и раньше.
  return useQuery({
    queryKey: ['reports', 'operations-counters', userId],
    queryFn: () => api.get<OperationsCountersResponse>('/reports/operations-counters'),
    enabled: !!userId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}
