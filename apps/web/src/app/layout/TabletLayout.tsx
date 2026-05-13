import { Layout, Menu, Button, Tooltip, Typography } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { filterByRole } from './navItems';
import { api } from '../../services/api';

const { Sider, Content, Header } = Layout;

export function TabletLayout() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const location = useLocation();

  if (!user) return null;
  const items = filterByRole(user.role).map((n) => ({
    key: n.path,
    label: (
      <Tooltip placement="right" title={n.label}>
        <div style={{ textAlign: 'center', padding: 4 }}>{n.label.slice(0, 3)}</div>
      </Tooltip>
    ),
  }));

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
    <Layout style={{ minHeight: '100dvh' }}>
      <Sider width={88} theme="light" collapsed>
        <div style={{ padding: 12, textAlign: 'center', fontWeight: 600 }}>mc</div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
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
            gap: 12,
          }}
        >
          <Typography.Text type="secondary">{user.email}</Typography.Text>
          <Button icon={<LogoutOutlined />} onClick={handleLogout}>
            Выход
          </Button>
        </Header>
        <Content style={{ padding: 16, background: '#f5f5f5' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
