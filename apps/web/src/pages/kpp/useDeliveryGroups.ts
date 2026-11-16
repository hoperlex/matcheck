import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryGroupComposeRequest,
  DeliveryGroupComposeResponse,
  DeliveryGroupDissolveResponse,
  DeliveryGroupLeaveResponse,
} from '@matcheck/contracts';
import { api } from '../../services/api';

const COLLAPSED_KEY = 'matcheck.deliveryGroups.collapsed';
const COLLAPSED_MAX = 300;

function readCollapsed(): string[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Свёрнутые группы — удобство этого браузера, не общее состояние: хранилище
 * может быть пустым или недоступным (приватное окно), тогда всё развёрнуто.
 * Помним последние 300, чтобы список не рос бесконечно.
 */
export function useCollapsedDeliveryGroups(): {
  collapsed: ReadonlySet<string>;
  toggle: (groupId: string) => void;
} {
  const [ids, setIds] = useState<string[]>(readCollapsed);
  const collapsed = useMemo(() => new Set(ids), [ids]);
  const toggle = useCallback((groupId: string) => {
    setIds((prev) => {
      const next = prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId].slice(-COLLAPSED_MAX);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Без хранилища свёрнутость живёт до перезагрузки — это не ошибка.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

/** Сбор, уход и роспуск группы; после любого — список и состав перечитываются. */
export function useDeliveryGroupMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['deliveries'] }),
      queryClient.invalidateQueries({ queryKey: ['delivery-group-members'] }),
    ]);
  const compose = useMutation({
    mutationFn: (body: DeliveryGroupComposeRequest) =>
      api.post<DeliveryGroupComposeResponse>('/delivery-groups', body),
    onSuccess: refresh,
  });
  const leave = useMutation({
    mutationFn: (deliveryIds: string[]) =>
      api.post<DeliveryGroupLeaveResponse>('/delivery-groups/leave', { deliveryIds }),
    onSuccess: refresh,
  });
  const dissolve = useMutation({
    mutationFn: (groupId: string) =>
      api.delete<DeliveryGroupDissolveResponse>(`/delivery-groups/${groupId}`),
    onSuccess: refresh,
  });
  return { compose, leave, dissolve };
}
