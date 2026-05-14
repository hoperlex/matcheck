import { Tabs, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const DEFAULT_TAB = '/references/sites';

const tabs = [
  { key: DEFAULT_TAB, label: 'Объекты' },
  { key: '/references/counterparties', label: 'Контрагенты' },
  { key: '/references/materials', label: 'Материалы' },
];

export default function ReferencesLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const active = tabs.find((t) => location.pathname.startsWith(t.key))?.key ?? DEFAULT_TAB;

  return (
    <div>
      <Typography.Title level={3}>Справочники</Typography.Title>
      <Tabs activeKey={active} items={tabs} onChange={(key) => navigate(key)} />
      <Outlet />
    </div>
  );
}
