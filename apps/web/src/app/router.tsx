import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
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
      { index: true, element: <Navigate to="/kpp" replace /> },
      { path: 'kpp', element: suspense(<KppPage />) },
      { path: 'shipments', element: suspense(<ShipmentPage />) },
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
