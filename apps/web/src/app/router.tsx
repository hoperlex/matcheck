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
const Materials = lazy(() => import('../pages/references/Materials'));
const ResponsiblePersons = lazy(() => import('../pages/references/ResponsiblePersons'));
const Assets = lazy(() => import('../pages/references/Assets'));
const MaterialsJournal = lazy(() => import('../pages/materials/MaterialsPage'));
const AdminUsers = lazy(() => import('../pages/admin/Users'));
const AdminLlmProviders = lazy(() => import('../pages/admin/LlmProviders'));
const AdminPrompts = lazy(() => import('../pages/admin/Prompts'));
const AdminEdoAccounts = lazy(() => import('../pages/admin/EdoAccounts'));
const AdminMailAccounts = lazy(() => import('../pages/admin/MailAccounts'));
const Settings = lazy(() => import('../pages/settings/Settings'));
const PublicSharePage = lazy(() => import('../pages/share/PublicSharePage'));
const OperationsPage = lazy(() => import('../pages/operations/OperationsPage'));

/**
 * Гард для /kpp: если в URL нет `delivery=<id>` и не флага `new=1`,
 * это листовой режим — перенаправляем на новый /operations?type=delivery,
 * сохранив все остальные query-параметры (фильтры, table-таб и т.п.).
 * Edit-режим (с delivery/new) рендерит KppPage как раньше.
 */
function KppGuard({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const hasEdit = params.get('delivery') !== null || params.get('new') === '1';
  if (hasEdit) return <>{children}</>;
  const next = new URLSearchParams(params);
  next.set('type', 'delivery');
  return <Navigate to={`/operations?${next.toString()}`} replace />;
}

/** То же для /shipments — редирект на /operations?type=shipment без edit-параметров. */
function ShipmentsGuard({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const hasEdit = params.get('shipment') !== null || params.get('new') === '1';
  if (hasEdit) return <>{children}</>;
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
        path: 'references',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>
            <ReferencesLayout />
          </ProtectedRoute>
        ),
        children: [
          { index: true, element: <Navigate to="/references/sites" replace /> },
          { path: 'sites', element: suspense(<Sites />) },
          { path: 'counterparties', element: suspense(<Counterparties />) },
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
      {
        // /settings — настройки устройства инспектора (PWA-кэш, синхронизация,
        // установка приложения, способ распознавания УПД). Manager заходить
        // не должен; admin использует тот же компонент через /admin/settings.
        path: 'settings',
        element: (
          <ProtectedRoute roles={['inspector_kpp']}>
            {suspense(<Settings />)}
          </ProtectedRoute>
        ),
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
