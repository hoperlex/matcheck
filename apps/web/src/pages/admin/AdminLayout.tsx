import { Tabs, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

const DEFAULT_TAB = '/admin/users';

const tabs = [
  { key: DEFAULT_TAB, label: 'Пользователи' },
  { key: '/admin/llm-providers', label: 'LLM провайдеры' },
  { key: '/admin/prompts', label: 'Промпты' },
  { key: '/admin/edo-accounts', label: 'ЭДО' },
  { key: '/admin/mail-accounts', label: 'Почта' },
  { key: '/admin/settings', label: 'Настройки' },
];

export default function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const active = tabs.find((t) => location.pathname.startsWith(t.key))?.key ?? DEFAULT_TAB;

  return (
    <StickyPageHeader
      header={
        <>
          <Typography.Title level={3} style={{ margin: '0 0 8px' }}>
            Администрирование
          </Typography.Title>
          <Tabs activeKey={active} items={tabs} onChange={(key) => navigate(key)} />
        </>
      }
    >
      <Outlet />
    </StickyPageHeader>
  );
}
