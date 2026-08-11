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
 * Когда задан `page`/`group`, решает ТОЛЬКО матрица: она умеет и сужать, и
 * расширять, поэтому конъюнкция со старым списком ролей сделала бы выданное
 * право бесполезным — страница осталась бы закрытой. `roles` работает как
 * прежде лишь там, где страницы в матрице нет вовсе.
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
  if (page) {
    return canView(perms, page, user.role) ? <>{children}</> : <NoAccess />;
  }
  if (group) {
    return canViewGroup(perms, group, user.role) ? <>{children}</> : <NoAccess />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
