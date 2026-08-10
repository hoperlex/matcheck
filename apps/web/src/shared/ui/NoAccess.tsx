import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { usePermissionsStore } from '../../stores/permissions';
import { homePath } from '../../app/layout/navItems';

/**
 * Экран «доступа нет».
 *
 * Нужен потому, что тихий редирект на корень при закрытых разделах
 * зацикливается: корень ведёт на первый доступный раздел, а доступных нет.
 * Лучше показать человеку понятную причину, чем крутить его между страницами.
 */
export function NoAccess({ title = 'Доступ закрыт' }: { title?: string }) {
  const navigate = useNavigate();
  const role = useAuthStore((s) => s.user?.role);
  const perms = usePermissionsStore((s) => s.perms);
  const home = homePath(perms, role);

  return (
    <Result
      status="403"
      title={title}
      subTitle="Раздел закрыт для вашей роли. Если доступ нужен для работы — обратитесь к администратору."
      extra={
        home ? (
          <Button type="primary" onClick={() => navigate(home, { replace: true })}>
            На доступный раздел
          </Button>
        ) : null
      }
    />
  );
}
