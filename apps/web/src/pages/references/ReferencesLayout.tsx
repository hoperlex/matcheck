import { Tabs, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

const DEFAULT_TAB = '/references/sites';

const tabs = [
  { key: DEFAULT_TAB, label: 'Объекты' },
  { key: '/references/counterparties', label: 'Контрагенты' },
  { key: '/references/responsible-persons', label: 'МОЛ' },
  { key: '/references/materials', label: 'Материалы' },
  { key: '/references/assets', label: 'ОС' },
];

export default function ReferencesLayout() {
  const location = useLocation();
  const navigate = useNavigate();

  const active = tabs.find((t) => location.pathname.startsWith(t.key))?.key ?? DEFAULT_TAB;

  return (
    <StickyPageHeader
      header={
        <>
          <Typography.Title level={3} style={{ margin: '0 0 8px' }}>
            Справочники
          </Typography.Title>
          <Tabs activeKey={active} items={tabs} onChange={(key) => navigate(key)} />
        </>
      }
    >
      <Outlet />
    </StickyPageHeader>
  );
}
