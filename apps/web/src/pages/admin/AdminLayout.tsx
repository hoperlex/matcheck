import { Tabs, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { PageId } from '@matcheck/contracts';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { pageUrl } from '../../shared/listMemory';
import { usePermissions } from '../../shared/hooks/usePermissions';

const DEFAULT_TAB = '/admin/users';

/**
 * Вкладки раздела вместе со страницами матрицы. Раньше список был плоским и
 * показывался целиком: для админа это верно, но матрица умеет выдать роли
 * ОДНУ вкладку — и тогда остальные вели бы её в отказ.
 */
export const ADMIN_TABS: { key: string; label: string; page: PageId }[] = [
  { key: DEFAULT_TAB, label: 'Пользователи', page: 'admin.users' },
  { key: '/admin/roles', label: 'Роли', page: 'admin.roles' },
  { key: '/admin/llm-providers', label: 'LLM провайдеры', page: 'admin.llm_providers' },
  { key: '/admin/prompts', label: 'Промпты', page: 'admin.prompts' },
  { key: '/admin/edo-accounts', label: 'ЭДО', page: 'admin.edo_accounts' },
  { key: '/admin/mail-accounts', label: 'Почта', page: 'admin.mail_accounts' },
  { key: '/admin/api-access', label: 'API-доступ', page: 'admin.api_access' },
  { key: '/admin/settings', label: 'Настройки', page: 'admin.settings' },
];

export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { canView } = usePermissions();

  const visibleTabs = ADMIN_TABS.filter((t) => canView(t.page));
  const active =
    visibleTabs.find((t) => location.pathname.startsWith(t.key))?.key ?? visibleTabs[0]?.key;

  return (
    <StickyPageHeader
      header={
        <>
          <Typography.Title level={3} style={{ margin: '0 0 8px' }}>
            Администрирование
          </Typography.Title>
          <Tabs
            activeKey={active}
            items={visibleTabs}
            // Вкладка открывается со своим поиском (shared/listMemory).
            onChange={(key) => navigate(pageUrl(key))}
          />
        </>
      }
    >
      <Outlet />
    </StickyPageHeader>
  );
}
