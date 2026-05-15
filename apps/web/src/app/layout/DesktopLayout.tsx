import { useEffect, useState, createElement } from 'react';
import { Avatar, Button, Layout, Menu, Tooltip, Typography } from 'antd';
import {
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { filterByRole } from './navItems';
import { api } from '../../services/api';

const { Sider, Content } = Layout;

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

  const avatarLetter = user.email.charAt(0).toUpperCase();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={240}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        theme="light"
        style={{ display: 'flex', flexDirection: 'column' }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
          }}
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
            style={{ flex: 1, borderInlineEnd: 'none' }}
          />
          <div
            style={{
              padding: collapsed ? '12px 8px' : 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: collapsed ? 'center' : 'stretch',
              gap: 8,
              borderTop: '1px solid #f0f0f0',
            }}
          >
            {collapsed ? (
              <>
                <Tooltip title={user.email} placement="right">
                  <Avatar size="small">{avatarLetter}</Avatar>
                </Tooltip>
                <Tooltip title="Выход" placement="right">
                  <Button
                    shape="circle"
                    size="small"
                    icon={<LogoutOutlined />}
                    onClick={handleLogout}
                    aria-label="Выход"
                  />
                </Tooltip>
                <Tooltip title="Развернуть меню" placement="right">
                  <Button
                    shape="circle"
                    size="small"
                    type="text"
                    icon={<MenuUnfoldOutlined />}
                    onClick={() => setCollapsed(false)}
                    aria-label="Развернуть меню"
                  />
                </Tooltip>
              </>
            ) : (
              <>
                <Typography.Text
                  type="secondary"
                  ellipsis={{ tooltip: user.email }}
                  style={{ fontSize: 12 }}
                >
                  {user.email}
                </Typography.Text>
                <Button block icon={<LogoutOutlined />} onClick={handleLogout}>
                  Выход
                </Button>
                <Button
                  block
                  type="text"
                  icon={<MenuFoldOutlined />}
                  onClick={() => setCollapsed(true)}
                >
                  Свернуть
                </Button>
              </>
            )}
          </div>
        </div>
      </Sider>
      <Layout>
        <Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
