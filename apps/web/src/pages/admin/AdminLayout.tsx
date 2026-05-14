import { Tabs, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

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
    <div>
      <Typography.Title level={3}>Администрирование</Typography.Title>
      <Tabs activeKey={active} items={tabs} onChange={(key) => navigate(key)} />
      <Outlet />
    </div>
  );
}
