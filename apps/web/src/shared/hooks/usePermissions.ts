import { useCallback, useMemo } from 'react';
import type { PageAction, PageGroup, PageId } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { usePermissionsStore } from '../../stores/permissions';
import { can, canView, canViewGroup } from '../utils/permissions';

/**
 * Права текущего пользователя для компонентов.
 *
 * Пока права не загрузились (или загрузиться не смогли), считаем по дефолтам
 * роли — интерфейс не должен мигать пустым меню из-за медленной сети. Роль
 * берём из auth-стора и передаём как fallback, вся остальная логика — в
 * shared/utils/permissions.ts.
 */
export function usePermissions() {
  const role = useAuthStore((s) => s.user?.role);
  const perms = usePermissionsStore((s) => s.perms);

  const canDo = useCallback(
    (page: PageId, action: PageAction) => can(perms, page, action, role),
    [perms, role],
  );
  const canSee = useCallback((page: PageId) => canView(perms, page, role), [perms, role]);
  const canSeeGroup = useCallback(
    (group: PageGroup) => canViewGroup(perms, group, role),
    [perms, role],
  );

  return useMemo(
    () => ({
      can: canDo,
      canView: canSee,
      canViewGroup: canSeeGroup,
      /** false — сервер матрицу не применяет (PERMISSIONS_ENFORCE=0). */
      enforced: perms?.enforced ?? false,
      /** Права ещё не приехали — UI работает по дефолтам роли. */
      loading: perms === null,
    }),
    [canDo, canSee, canSeeGroup, perms],
  );
}
