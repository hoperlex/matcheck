import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { AppShell } from './layout/AppShell';
import { ProtectedRoute } from '../shared/ui/ProtectedRoute';

const Login = lazy(() => import('../pages/auth/Login'));
const Register = lazy(() => import('../pages/auth/Register'));
const Dashboard = lazy(() => import('../pages/dashboard/Dashboard'));
const Inbox = lazy(() => import('../pages/inbox/Inbox'));
const DeliveriesList = lazy(() => import('../pages/deliveries/DeliveriesList'));
const DeliveryDetail = lazy(() => import('../pages/deliveries/DeliveryDetail'));
const KppPage = lazy(() => import('../pages/kpp/KppPage'));
const Counterparties = lazy(() => import('../pages/references/Counterparties'));
const Materials = lazy(() => import('../pages/references/Materials'));
const AdminUsers = lazy(() => import('../pages/admin/Users'));
const AdminLlmProviders = lazy(() => import('../pages/admin/LlmProviders'));
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
      { index: true, element: suspense(<Dashboard />) },
      { path: 'kpp', element: suspense(<KppPage />) },
      {
        path: 'inbox',
        element: (
          <ProtectedRoute roles={['admin', 'manager']}>{suspense(<Inbox />)}</ProtectedRoute>
        ),
      },
      { path: 'deliveries', element: suspense(<DeliveriesList />) },
      { path: 'deliveries/:id', element: suspense(<DeliveryDetail />) },
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
        path: 'admin/users',
        element: <ProtectedRoute roles={['admin']}>{suspense(<AdminUsers />)}</ProtectedRoute>,
      },
      {
        path: 'admin/llm-providers',
        element: (
          <ProtectedRoute roles={['admin']}>{suspense(<AdminLlmProviders />)}</ProtectedRoute>
        ),
      },
      {
        path: 'admin/edo-accounts',
        element: (
          <ProtectedRoute roles={['admin']}>{suspense(<AdminEdoAccounts />)}</ProtectedRoute>
        ),
      },
      {
        path: 'admin/mail-accounts',
        element: (
          <ProtectedRoute roles={['admin']}>{suspense(<AdminMailAccounts />)}</ProtectedRoute>
        ),
      },
      { path: 'settings', element: suspense(<Settings />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
