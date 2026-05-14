import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { AppShell } from './layout/AppShell';
import { ProtectedRoute } from '../shared/ui/ProtectedRoute';
import AdminLayout from '../pages/admin/AdminLayout';

const Login = lazy(() => import('../pages/auth/Login'));
const Register = lazy(() => import('../pages/auth/Register'));
const Inbox = lazy(() => import('../pages/inbox/Inbox'));
const KppPage = lazy(() => import('../pages/kpp/KppPage'));
const Counterparties = lazy(() => import('../pages/references/Counterparties'));
const Materials = lazy(() => import('../pages/references/Materials'));
const MaterialsJournal = lazy(() => import('../pages/materials/MaterialsPage'));
const AdminUsers = lazy(() => import('../pages/admin/Users'));
const AdminLlmProviders = lazy(() => import('../pages/admin/LlmProviders'));
const AdminPrompts = lazy(() => import('../pages/admin/Prompts'));
const AdminEdoAccounts = lazy(() => import('../pages/admin/EdoAccounts'));
const AdminMailAccounts = lazy(() => import('../pages/admin/MailAccounts'));
const Settings = lazy(() => import('../pages/settings/Settings'));

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
      {
        path: 'documents',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>{suspense(<Inbox />)}</ProtectedRoute>
        ),
      },
      { path: 'inbox', element: <Navigate to="/documents" replace /> },
      { path: 'materials', element: suspense(<MaterialsJournal />) },
      {
        path: 'references/counterparties',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>
            {suspense(<Counterparties />)}
          </ProtectedRoute>
        ),
      },
      {
        path: 'references/materials',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>{suspense(<Materials />)}</ProtectedRoute>
        ),
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
      { path: 'settings', element: suspense(<Settings />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
