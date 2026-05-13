import { useEffect, useState, createElement } from 'react';
import { Layout, Menu, Button, Space, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { filterByRole } from './navItems';
import { api } from '../../services/api';

const { Header, Sider, Content } = Layout;

const COLLAPSE_KEY = 'matcheck.sidebar.collapsed';

export function DesktopLayout() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  if (!user) return null;
  const items = filterByRole(user.role).map((n) => ({
    key: n.path,
    icon: createElement(n.icon),
    label: n.label,
  }));
  const selected = items.find(
    (i) => location.pathname === i.key || (i.key !== '/' && location.pathname.startsWith(i.key)),
  );

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={240}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="light"
      >
        <div
          style={{
            padding: collapsed ? '16px 8px' : 16,
            fontWeight: 600,
            fontSize: 18,
            textAlign: collapsed ? 'center' : 'left',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {collapsed ? 'mc' : 'matcheck'}
        </div>
        <Menu
          mode="inline"
          selectedKeys={selected ? [selected.key] : []}
          items={items}
          onClick={(e) => navigate(e.key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <Space>
            <Typography.Text type="secondary">{user.email}</Typography.Text>
            <Typography.Text code>{user.role}</Typography.Text>
            <Button onClick={handleLogout}>Выход</Button>
          </Space>
        </Header>
        <Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
