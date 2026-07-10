import { useMemo, useState, createElement } from 'react';
import { Layout, Drawer, Button, Menu, Tag, Typography } from 'antd';
import { MenuOutlined, UserOutlined } from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { filterByRole } from './navItems';
import { roleLabel } from '../../shared/constants/roleLabels';
import { api } from '../../services/api';
import { UserProfileModal } from '../../components/UserProfileModal';
import { NotificationsBell } from '../../components/NotificationsBell';
import { useOperationsCounters } from '../../shared/hooks/useOperationsCounters';

const { Header, Content, Footer } = Layout;

const PRIMARY_KEYS = ['/kpp', '/documents'];

export function MobileLayout() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const counters = useOperationsCounters();
  const operationsCount = counters.data?.completedToday ?? 0;

  // Мемоизируем меню: без этого label с Tag пересоздаётся на каждом рендере и
  // antd Menu ремонтирует узел label → тег «Сегодня: +N» мигает. useMemo — до
  // early-return ниже (порядок хуков).
  const allItems = useMemo(() => {
    if (!user) return [];
    // Drawer-меню — label с Tag «+N» для «Операции».
    return filterByRole(user.role).map((n) => ({
      key: n.path,
      icon: createElement(n.icon),
      label:
        n.key === 'operations' && operationsCount > 0 ? (
          <span>
            {n.label}
            <Tag color="green" style={{ marginLeft: 16, marginInlineEnd: 0 }}>
              Сегодня: +{operationsCount}
            </Tag>
          </span>
        ) : (
          n.label
        ),
    }));
  }, [user, operationsCount]);
  // Footer-табы — короткие label без Tag (узкие тач-цели, +N испортит верстку).
  const tabItems = useMemo(
    () =>
      allItems
        .filter((it) => PRIMARY_KEYS.includes(it.key))
        .map((it) => {
          const orig = user ? filterByRole(user.role).find((n) => n.path === it.key) : undefined;
          return { ...it, label: orig?.label ?? it.label };
        }),
    [allItems, user],
  );

  if (!user) return null;
  const displayName = user.fullName?.trim() || user.email;

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
      <Header
        style={{
          background: '#fff',
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Button icon={<MenuOutlined />} onClick={() => setOpen(true)} size="large" />
        <Typography.Text strong style={{ fontSize: 16, flex: 1 }}>
          matcheck
        </Typography.Text>
        <NotificationsBell />
        <Typography.Text code style={{ fontSize: 11 }}>
          {roleLabel(user.role)}
        </Typography.Text>
      </Header>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        placement="left"
        width={280}
        title={displayName}
      >
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={allItems}
          onClick={(e) => {
            navigate(e.key);
            setOpen(false);
          }}
        />
        {/* Кнопка «Выход» переехала в footer модалки Личного кабинета —
            единственная точка выхода из системы (UX-стандарт). */}
        <Button
          icon={<UserOutlined />}
          block
          style={{ marginTop: 16 }}
          onClick={() => {
            setOpen(false);
            setProfileOpen(true);
          }}
          size="large"
        >
          Личный кабинет
        </Button>
      </Drawer>
      <UserProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onLogout={handleLogout}
      />
      <Content
        style={{
          padding: 12,
          background: '#f5f5f5',
          flex: 1,
          overflowY: 'auto',
          // Симметрично DesktopLayout: резервируем полосу прокрутки, чтобы её
          // появление/исчезновение не меняло ширину контента (иначе фильтры
          // «дребезжат» при выборе значения). Основной баг на desktop, но
          // держим оба layout'а одинаковыми.
          scrollbarGutter: 'stable',
        }}
      >
        <Outlet />
      </Content>
      <Footer style={{ padding: 0, background: '#fff', borderTop: '1px solid #f0f0f0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tabItems.length}, 1fr)` }}>
          {tabItems.map((tab) => (
            <Button
              key={tab.key}
              type={location.pathname === tab.key ? 'primary' : 'text'}
              size="large"
              onClick={() => navigate(tab.key)}
              style={{ height: 56, borderRadius: 0 }}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      </Footer>
    </Layout>
  );
}
