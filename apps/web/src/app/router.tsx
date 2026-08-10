import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { Spin } from 'antd';
import { AppShell } from './layout/AppShell';
import { ProtectedRoute } from '../shared/ui/ProtectedRoute';
import { NoAccess } from '../shared/ui/NoAccess';
import { homePath } from './layout/navItems';
import { canView } from '../shared/utils/permissions';
import { useAuthStore } from '../stores/auth';
import { usePermissionsStore } from '../stores/permissions';
import AdminLayout from '../pages/admin/AdminLayout';
import ReferencesLayout, { TAB_DEFS as REFERENCE_TABS } from '../pages/references/ReferencesLayout';

const Login = lazy(() => import('../pages/auth/Login'));
const Register = lazy(() => import('../pages/auth/Register'));
const Inbox = lazy(() => import('../pages/inbox/Inbox'));
const MailReview = lazy(() => import('../pages/inbox/MailReview'));
const ExtraOnlyBundles = lazy(() => import('../pages/inbox/ExtraOnlyBundles'));
const KppPage = lazy(() => import('../pages/kpp/KppPage'));
const ShipmentPage = lazy(() => import('../pages/shipments/ShipmentPage'));
const Sites = lazy(() => import('../pages/references/Sites'));
const Counterparties = lazy(() => import('../pages/references/Counterparties'));
const Suppliers = lazy(() => import('../pages/references/Suppliers'));
const CustomerCounterparties = lazy(() => import('../pages/references/CustomerCounterparties'));
const Materials = lazy(() => import('../pages/references/Materials'));
const ResponsiblePersons = lazy(() => import('../pages/references/ResponsiblePersons'));
const MolPersons = lazy(() => import('../pages/references/MolPersons'));
const Units = lazy(() => import('../pages/references/Units'));
const Assets = lazy(() => import('../pages/references/Assets'));
const MaterialsJournal = lazy(() => import('../pages/materials/MaterialsPage'));
const StatsPage = lazy(() => import('../pages/stats/StatsPage'));
const AdminUsers = lazy(() => import('../pages/admin/Users'));
const AdminRoles = lazy(() => import('../pages/admin/roles/RolesPage'));
const AdminLlmProviders = lazy(() => import('../pages/admin/LlmProviders'));
const AdminPrompts = lazy(() => import('../pages/admin/Prompts'));
const AdminEdoAccounts = lazy(() => import('../pages/admin/EdoAccounts'));
const AdminMailAccounts = lazy(() => import('../pages/admin/MailAccounts'));
const Settings = lazy(() => import('../pages/settings/Settings'));
const ForgotPassword = lazy(() => import('../pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('../pages/auth/ResetPassword'));
const PublicSharePage = lazy(() => import('../pages/share/PublicSharePage'));
const PublicUploadPage = lazy(() => import('../pages/public-upload/PublicUploadPage'));
const OperationsPage = lazy(() => import('../pages/operations/OperationsPage'));

// Feature flag-страховка: если выставлен VITE_OPERATIONS_MODAL_DISABLED=1,
// гарды пропускают edit-параметры на старую полноэкранную KppPage/
// ShipmentPage без редиректа. По умолчанию edit-режим тоже редиректит на
// /operations (этап Г): модалка — единственная точка входа в форму.
const MODAL_DISABLED = import.meta.env.VITE_OPERATIONS_MODAL_DISABLED === '1';

/**
 * Корень: ведёт на первый доступный человеку раздел.
 *
 * Раньше здесь стоял жёсткий Navigate на /operations. С матрицей это давало бы
 * цикл: закрытые операции → отказ → редирект на корень → снова /operations.
 */
function HomeRedirect() {
  const role = useAuthStore((s) => s.user?.role);
  const perms = usePermissionsStore((s) => s.perms);
  const home = homePath(perms, role);
  if (!home) return <NoAccess title="Нет доступных разделов" />;
  // Операции живут на одном роуте с ?type=: без параметра страница не знает,
  // какую вкладку открывать.
  return <Navigate to={home === '/operations' ? '/operations?type=delivery' : home} replace />;
}

/**
 * Вход в «Справочники» — на первую ДОСТУПНУЮ вкладку.
 *
 * Жёсткий редирект на /references/sites оставлял бы человека без права на
 * «Объекты» перед отказом, хотя соседние вкладки ему открыты.
 */
function ReferencesHome() {
  const role = useAuthStore((s) => s.user?.role);
  const perms = usePermissionsStore((s) => s.perms);
  const first = REFERENCE_TABS.find((t) => canView(perms, t.page, role));
  if (!first) return <NoAccess title="Справочники закрыты" />;
  return <Navigate to={first.key} replace />;
}

/**
 * Гард для /kpp: всегда редиректит на /operations?type=delivery&…,
 * сохраняя все query-параметры. Edit-параметры (?delivery=, ?new=1,
 * ?upd=, ?from=) подхватывает OperationsPage и открывает модалку.
 * Это устраняет дубликат UI-точки входа: старые ссылки и закладки
 * `matcheck.fvds.ru/kpp?delivery=<id>` приземляются на модалке.
 *
 * Под feature flag VITE_OPERATIONS_MODAL_DISABLED=1 edit-параметры
 * продолжают рендерить KppPage как полноэкранную страницу (страховка
 * на случай проблем с модалкой на проде).
 */
function KppGuard({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  if (MODAL_DISABLED) {
    const hasEdit = params.get('delivery') !== null || params.get('new') === '1';
    if (hasEdit) return <>{children}</>;
  }
  const next = new URLSearchParams(params);
  next.set('type', 'delivery');
  return <Navigate to={`/operations?${next.toString()}`} replace />;
}

/** То же для /shipments — всегда редирект на /operations?type=shipment&…. */
function ShipmentsGuard({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  if (MODAL_DISABLED) {
    const hasEdit = params.get('shipment') !== null || params.get('new') === '1';
    if (hasEdit) return <>{children}</>;
  }
  const next = new URLSearchParams(params);
  next.set('type', 'shipment');
  return <Navigate to={`/operations?${next.toString()}`} replace />;
}

function suspense(node: React.ReactNode) {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24 }}>
          <Spin />
        </div>
      }
    >
      {node}
    </Suspense>
  );
}

// Обёртка Sentry поверх createBrowserRouter — поведение идентично, добавляет
// только инструментацию навигации. Без инициализированного Sentry (нет DSN) — no-op.
const sentryCreateBrowserRouter = Sentry.wrapCreateBrowserRouterV7(createBrowserRouter);

export const router = sentryCreateBrowserRouter([
  { path: '/login', element: suspense(<Login />) },
  { path: '/register', element: suspense(<Register />) },
  // Заявка «Забыли пароль?»: человек без доступа к порталу по определению не
  // авторизован, поэтому обе страницы вне ProtectedRoute.
  { path: '/forgot-password', element: suspense(<ForgotPassword />) },
  // Токен ездит во ФРАГМЕНТЕ (/reset-password#<token>), а не в пути: фрагмент
  // не уходит на сервер, поэтому не оседает в логах прокси и Referer. Отсюда и
  // маршрут без параметра.
  { path: '/reset-password', element: suspense(<ResetPassword />) },
  // Публичная страница просмотра приёмки/отгрузки по share-токену.
  // Вне ProtectedRoute: доступ по знанию unguessable токена, без логина.
  { path: '/share/:token', element: suspense(<PublicSharePage />) },
  // Публичная загрузка документов поставщиком: ссылку рассылают наружу,
  // логина у поставщика нет и не будет. Тоже вне ProtectedRoute.
  { path: '/uploads', element: suspense(<PublicUploadPage />) },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        path: 'operations',
        // Группа, а не страница: на одном роуте живут Приёмки и Отгрузки,
        // и достаточно доступа к любой из них — какую открыть, решает сама
        // страница по ?type=.
        element: <ProtectedRoute group="operations">{suspense(<OperationsPage />)}</ProtectedRoute>,
      },
      // /kpp и /shipments оставлены для edit-режима (форма приёмки/отгрузки
      // с ?delivery=…/?shipment=… или ?new=1). Без edit-параметров гарды
      // перенаправляют на /operations?type=… — старые закладки и ссылки
      // продолжают работать.
      {
        // Гейт нужен и здесь: legacy-роуты ведут прямо на форму, минуя
        // /operations, — без проверки они были бы обходом матрицы по прямой
        // ссылке из закладок.
        path: 'kpp',
        element: (
          <ProtectedRoute page="operations.deliveries">
            <KppGuard>{suspense(<KppPage />)}</KppGuard>
          </ProtectedRoute>
        ),
      },
      {
        path: 'shipments',
        element: (
          <ProtectedRoute page="operations.shipments">
            <ShipmentsGuard>{suspense(<ShipmentPage />)}</ShipmentsGuard>
          </ProtectedRoute>
        ),
      },
      {
        path: 'documents',
        element: (
          <ProtectedRoute roles={['admin', 'manager', 'contractor']} page="documents.list">
            {suspense(<Inbox />)}
          </ProtectedRoute>
        ),
      },
      {
        // Разбор почты — только для тех, кто заводит документы: подрядчику
        // чужие письма видеть нельзя.
        path: 'documents/mail',
        element: (
          <ProtectedRoute roles={['admin', 'manager']} page="documents.mail">
            {suspense(<MailReview />)}
          </ProtectedRoute>
        ),
      },
      {
        // Комплекты без распознанных документов — тоже инструмент разбора.
        path: 'documents/extra-only',
        element: (
          <ProtectedRoute roles={['admin', 'manager']} page="documents.extra_only">
            {suspense(<ExtraOnlyBundles />)}
          </ProtectedRoute>
        ),
      },
      { path: 'inbox', element: <Navigate to="/documents" replace /> },
      {
        path: 'materials',
        // Журнал бьёт по /reports/*, закрытым для contractor — не пускаем его сюда.
        element: (
          <ProtectedRoute roles={['admin', 'manager', 'inspector_kpp']} page="materials_journal">
            {suspense(<MaterialsJournal />)}
          </ProtectedRoute>
        ),
      },
      {
        path: 'stats',
        element: (
          <ProtectedRoute roles={['admin', 'manager']} page="stats">
            {suspense(<StatsPage />)}
          </ProtectedRoute>
        ),
      },
      {
        path: 'references',
        element: (
          <ProtectedRoute roles={['admin', 'manager']} group="references">
            <ReferencesLayout />
          </ProtectedRoute>
        ),
        children: [
          { index: true, element: <ReferencesHome /> },
          {
            path: 'sites',
            element: (
              <ProtectedRoute page="references.sites">{suspense(<Sites />)}</ProtectedRoute>
            ),
          },
          // Вкладка «Контрагенты» теперь показывает справочник заказчика
          // (customer_counterparties), а «Поставщики» — suppliers. Обе —
          // отдельные таблицы, не операционная counterparties.
          {
            path: 'counterparties',
            element: (
              <ProtectedRoute page="references.customer_counterparties">
                {suspense(<CustomerCounterparties />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'suppliers',
            element: (
              <ProtectedRoute page="references.suppliers">
                {suspense(<Suppliers />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'mol',
            element: (
              <ProtectedRoute page="references.mol">{suspense(<MolPersons />)}</ProtectedRoute>
            ),
          },
          {
            path: 'units',
            element: (
              <ProtectedRoute page="references.units">{suspense(<Units />)}</ProtectedRoute>
            ),
          },
          // Операционный справочник контрагентов (legacy): завязан на FK
          // приёмок/отгрузок и sync мобилы. Из вкладок убран, но роут сохранён
          // для ручного доступа администратором при необходимости.
          {
            path: 'counterparties-legacy',
            element: (
              <ProtectedRoute page="references.counterparties_legacy">
                {suspense(<Counterparties />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'responsible-persons',
            element: (
              <ProtectedRoute page="references.responsible_persons">
                {suspense(<ResponsiblePersons />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'materials',
            element: (
              <ProtectedRoute page="references.materials">
                {suspense(<Materials />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'assets',
            element: (
              <ProtectedRoute page="references.assets">{suspense(<Assets />)}</ProtectedRoute>
            ),
          },
        ],
      },
      {
        path: 'admin',
        element: (
          <ProtectedRoute roles={['admin']} group="admin">
            <AdminLayout />
          </ProtectedRoute>
        ),
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          {
            path: 'users',
            element: <ProtectedRoute page="admin.users">{suspense(<AdminUsers />)}</ProtectedRoute>,
          },
          {
            path: 'roles',
            element: <ProtectedRoute page="admin.roles">{suspense(<AdminRoles />)}</ProtectedRoute>,
          },
          {
            path: 'llm-providers',
            element: (
              <ProtectedRoute page="admin.llm_providers">
                {suspense(<AdminLlmProviders />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'prompts',
            element: (
              <ProtectedRoute page="admin.prompts">{suspense(<AdminPrompts />)}</ProtectedRoute>
            ),
          },
          {
            path: 'edo-accounts',
            element: (
              <ProtectedRoute page="admin.edo_accounts">
                {suspense(<AdminEdoAccounts />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'mail-accounts',
            element: (
              <ProtectedRoute page="admin.mail_accounts">
                {suspense(<AdminMailAccounts />)}
              </ProtectedRoute>
            ),
          },
          {
            path: 'settings',
            element: (
              <ProtectedRoute page="admin.settings">{suspense(<Settings />)}</ProtectedRoute>
            ),
          },
        ],
      },
      // Top-level роут /settings убран: раздел «Настройки» больше не
      // показываем ни manager, ни inspector_kpp. Способ распознавания УПД
      // и прочие настройки доступны только admin через /admin/settings
      // (тот же компонент Settings). Прямой заход на /settings уходит в `*`.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
