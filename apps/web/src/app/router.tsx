import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useSearchParams } from 'react-router-dom';
import { Spin } from 'antd';
import { AppShell } from './layout/AppShell';
import { ProtectedRoute } from '../shared/ui/ProtectedRoute';
import AdminLayout from '../pages/admin/AdminLayout';
import ReferencesLayout from '../pages/references/ReferencesLayout';

const Login = lazy(() => import('../pages/auth/Login'));
const Register = lazy(() => import('../pages/auth/Register'));
const Inbox = lazy(() => import('../pages/inbox/Inbox'));
const KppPage = lazy(() => import('../pages/kpp/KppPage'));
const ShipmentPage = lazy(() => import('../pages/shipments/ShipmentPage'));
const Sites = lazy(() => import('../pages/references/Sites'));
const Counterparties = lazy(() => import('../pages/references/Counterparties'));
const Suppliers = lazy(() => import('../pages/references/Suppliers'));
const CustomerCounterparties = lazy(() => import('../pages/references/CustomerCounterparties'));
const Materials = lazy(() => import('../pages/references/Materials'));
const ResponsiblePersons = lazy(() => import('../pages/references/ResponsiblePersons'));
const MolPersons = lazy(() => import('../pages/references/MolPersons'));
const Assets = lazy(() => import('../pages/references/Assets'));
const MaterialsJournal = lazy(() => import('../pages/materials/MaterialsPage'));
const StatsPage = lazy(() => import('../pages/stats/StatsPage'));
const AdminUsers = lazy(() => import('../pages/admin/Users'));
const AdminLlmProviders = lazy(() => import('../pages/admin/LlmProviders'));
const AdminPrompts = lazy(() => import('../pages/admin/Prompts'));
const AdminEdoAccounts = lazy(() => import('../pages/admin/EdoAccounts'));
const AdminMailAccounts = lazy(() => import('../pages/admin/MailAccounts'));
const Settings = lazy(() => import('../pages/settings/Settings'));
const PublicSharePage = lazy(() => import('../pages/share/PublicSharePage'));
const OperationsPage = lazy(() => import('../pages/operations/OperationsPage'));

// Feature flag-страховка: если выставлен VITE_OPERATIONS_MODAL_DISABLED=1,
// гарды пропускают edit-параметры на старую полноэкранную KppPage/
// ShipmentPage без редиректа. По умолчанию edit-режим тоже редиректит на
// /operations (этап Г): модалка — единственная точка входа в форму.
const MODAL_DISABLED = import.meta.env.VITE_OPERATIONS_MODAL_DISABLED === '1';

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

export const router = createBrowserRouter([
  { path: '/login', element: suspense(<Login />) },
  { path: '/register', element: suspense(<Register />) },
  // Публичная страница просмотра приёмки/отгрузки по share-токену.
  // Вне ProtectedRoute: доступ по знанию unguessable токена, без логина.
  { path: '/share/:token', element: suspense(<PublicSharePage />) },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/operations?type=delivery" replace /> },
      { path: 'operations', element: suspense(<OperationsPage />) },
      // /kpp и /shipments оставлены для edit-режима (форма приёмки/отгрузки
      // с ?delivery=…/?shipment=… или ?new=1). Без edit-параметров гарды
      // перенаправляют на /operations?type=… — старые закладки и ссылки
      // продолжают работать.
      {
        path: 'kpp',
        element: <KppGuard>{suspense(<KppPage />)}</KppGuard>,
      },
      {
        path: 'shipments',
        element: <ShipmentsGuard>{suspense(<ShipmentPage />)}</ShipmentsGuard>,
      },
      {
        path: 'documents',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>{suspense(<Inbox />)}</ProtectedRoute>
        ),
      },
      { path: 'inbox', element: <Navigate to="/documents" replace /> },
      { path: 'materials', element: suspense(<MaterialsJournal />) },
      {
        path: 'stats',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>{suspense(<StatsPage />)}</ProtectedRoute>
        ),
      },
      {
        path: 'references',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>
            <ReferencesLayout />
          </ProtectedRoute>
        ),
        children: [
          { index: true, element: <Navigate to="/references/sites" replace /> },
          { path: 'sites', element: suspense(<Sites />) },
          // Вкладка «Контрагенты» теперь показывает справочник заказчика
          // (customer_counterparties), а «Поставщики» — suppliers. Обе —
          // отдельные таблицы, не операционная counterparties.
          { path: 'counterparties', element: suspense(<CustomerCounterparties />) },
          { path: 'suppliers', element: suspense(<Suppliers />) },
          { path: 'mol', element: suspense(<MolPersons />) },
          // Операционный справочник контрагентов (legacy): завязан на FK
          // приёмок/отгрузок и sync мобилы. Из вкладок убран, но роут сохранён
          // для ручного доступа администратором при необходимости.
          { path: 'counterparties-legacy', element: suspense(<Counterparties />) },
          { path: 'responsible-persons', element: suspense(<ResponsiblePersons />) },
          { path: 'materials', element: suspense(<Materials />) },
          { path: 'assets', element: suspense(<Assets />) },
        ],
      },
      {
        path: 'admin',
        element: (
          <ProtectedRoute roles={['admin']}>
            <AdminLayout />
          </ProtectedRoute>
        ),
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: 'users', element: suspense(<AdminUsers />) },
          { path: 'llm-providers', element: suspense(<AdminLlmProviders />) },
          { path: 'prompts', element: suspense(<AdminPrompts />) },
          { path: 'edo-accounts', element: suspense(<AdminEdoAccounts />) },
          { path: 'mail-accounts', element: suspense(<AdminMailAccounts />) },
          { path: 'settings', element: suspense(<Settings />) },
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
