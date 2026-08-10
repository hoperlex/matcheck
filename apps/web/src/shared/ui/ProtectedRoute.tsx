import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { PageGroup, PageId, UserRole } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { usePermissionsStore } from '../../stores/permissions';
import { canView, canViewGroup } from '../utils/permissions';
import { NoAccess } from './NoAccess';

/**
 * Гард роута.
 *
 * `page`/`group` — проверка по матрице прав; `roles` — прежний allow-list,
 * оставлен рабочим для роутов, которых матрица не касается. Когда заданы оба,
 * действуют оба: матрица только СУЖАЕТ, поэтому конъюнкция — единственный
 * безопасный вариант.
 *
 * Отказ показывает NoAccess, а НЕ редирект на корень: корень ведёт на первый
 * доступный раздел, и при закрытом разделе редирект зациклился бы.
 */
export function ProtectedRoute({
  roles,
  page,
  group,
  children,
}: {
  roles?: UserRole[];
  page?: PageId;
  group?: PageGroup;
  children: ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  const perms = usePermissionsStore((s) => s.perms);
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  if (page && !canView(perms, page, user.role)) {
    return <NoAccess />;
  }
  if (group && !canViewGroup(perms, group, user.role)) {
    return <NoAccess />;
  }
  return <>{children}</>;
}
