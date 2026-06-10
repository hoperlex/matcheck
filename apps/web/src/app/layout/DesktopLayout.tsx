import { useEffect, useState, createElement } from 'react';
import { Avatar, Button, Layout, Menu, Tag, Tooltip, Typography } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { filterByRole } from './navItems';
import { api } from '../../services/api';
import { UserProfileModal } from '../../components/UserProfileModal';
import { NotificationsBell } from '../../components/NotificationsBell';
import { useOperationsCounters } from '../../shared/hooks/useOperationsCounters';

const { Sider, Content } = Layout;

const COLLAPSE_KEY = 'matcheck.sidebar.collapsed';

export function DesktopLayout() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    // По умолчанию sidebar свёрнут — экономит горизонтальное место под
    // таблицы. Если пользователь развернул его, выбор сохраняется в
    // localStorage и переживает F5. Только явное значение '0' = раскрыт;
    // отсутствие ключа или любое другое значение → свёрнут.
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(COLLAPSE_KEY) !== '0';
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const counters = useOperationsCounters();

  if (!user) return null;
  const operationsCount = counters.data?.completedToday ?? 0;
  const items = filterByRole(user.role).map((n) => ({
    key: n.path,
    icon: createElement(n.icon),
    // Для «Операции» — зелёный Tag «Сегодня: +N» справа от label.
    // Раньше при двузначном счётчике (+10, +12 и т.д.) тегу не хватало
    // места, и antd Menu начинал ellipsis'ить сам label до «Операции...».
    // Flex-layout с minWidth:0 + whiteSpace:nowrap на тексте и
    // flexShrink:0 на теге гарантирует, что тег полностью виден, а
    // текст «Операции» не обрезается. При 0 — Tag не рисуем.
    label:
      n.key === 'operations' && operationsCount > 0 ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ whiteSpace: 'nowrap' }}>{n.label}</span>
          <Tag color="green" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
            Сегодня: +{operationsCount}
          </Tag>
        </span>
      ) : (
        n.label
      ),
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

  // ФИО важнее в шапке: если есть — показываем его, иначе email. Аватарка —
  // первая буква от того, что показываем (быстрая идентификация).
  const displayName = user.fullName?.trim() || user.email;
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const [profileOpen, setProfileOpen] = useState(false);

  const siderWidth = collapsed ? 64 : 240;
  return (
    // Shell зафиксирован в высоту окна (height + overflow:hidden), документ
    // НЕ скроллится. Скролл живёт внутри Content (overflowY:auto) — это
    // убирает «внешний» скролл всей страницы. Табличные страницы
    // самоограничивают высоту (ResponsiveTable scroll.y) и Content не
    // переполняют; высокие не-табличные (Настройки и т.п.) скроллятся
    // внутри Content. Паттерн зеркалит MobileLayout.
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider
        width={240}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        theme="light"
        // Fixed sidebar: остаётся слева при скролле контента, см. UX-задачу.
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          height: '100vh',
          overflow: 'auto',
          zIndex: 100,
        }}
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
                <NotificationsBell collapsed />
                <Tooltip title={`${displayName} — Личный кабинет`} placement="right">
                  <Avatar
                    size="small"
                    onClick={() => setProfileOpen(true)}
                    style={{ cursor: 'pointer' }}
                  >
                    {avatarLetter}
                  </Avatar>
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
                {/* Карточка юзера — кликабельная, открывает Личный кабинет.
                    ФИО сверху (если есть), email подписью; иначе только email.
                    Кнопка «Выход» переехала в footer модалки Личного кабинета
                    (стандарт UX — logout — редкое действие, прячем в профиль).
                    Колокольчик уведомлений — справа от карточки. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    onClick={() => setProfileOpen(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                      flex: 1,
                      minWidth: 0,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    title="Открыть личный кабинет"
                  >
                    <Avatar size="small">{avatarLetter}</Avatar>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {user.fullName ? (
                        <>
                          <Typography.Text
                            ellipsis={{ tooltip: user.fullName }}
                            style={{ fontSize: 13, display: 'block', lineHeight: 1.2 }}
                          >
                            {user.fullName}
                          </Typography.Text>
                          <Typography.Text
                            type="secondary"
                            ellipsis={{ tooltip: user.email }}
                            style={{ fontSize: 11, display: 'block', lineHeight: 1.2 }}
                          >
                            {user.email}
                          </Typography.Text>
                        </>
                      ) : (
                        <Typography.Text
                          ellipsis={{ tooltip: user.email }}
                          style={{ fontSize: 13 }}
                        >
                          {user.email}
                        </Typography.Text>
                      )}
                    </div>
                  </div>
                  <NotificationsBell />
                </div>
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
      <Layout
        style={{
          marginInlineStart: siderWidth,
          transition: 'margin-inline-start 0.2s',
          height: '100vh',
        }}
      >
        <Content style={{ padding: '12px 24px 8px', background: '#f5f5f5', flex: 1, overflowY: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
      <UserProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onLogout={handleLogout}
      />
    </Layout>
  );
}
