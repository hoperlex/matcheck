import type { UserRole } from '@matcheck/contracts';

export type NavItem = {
  key: string;
  label: string;
  path: string;
  roles: UserRole[];
};

export const navItems: NavItem[] = [
  { key: 'dashboard', label: 'Сводка', path: '/', roles: ['admin', 'manager', 'inspector_kpp'] },
  { key: 'kpp', label: 'КПП', path: '/kpp', roles: ['admin', 'manager', 'inspector_kpp'] },
  { key: 'inbox', label: 'Входящие', path: '/inbox', roles: ['admin', 'manager'] },
  {
    key: 'deliveries',
    label: 'Приёмки',
    path: '/deliveries',
    roles: ['admin', 'manager', 'inspector_kpp'],
  },
  {
    key: 'counterparties',
    label: 'Контрагенты',
    path: '/references/counterparties',
    roles: ['admin', 'manager'],
  },
  {
    key: 'materials',
    label: 'Материалы',
    path: '/references/materials',
    roles: ['admin', 'manager'],
  },
  { key: 'admin-users', label: 'Пользователи', path: '/admin/users', roles: ['admin'] },
  { key: 'admin-llm', label: 'LLM провайдеры', path: '/admin/llm-providers', roles: ['admin'] },
  { key: 'admin-edo', label: 'ЭДО', path: '/admin/edo-accounts', roles: ['admin'] },
  { key: 'admin-mail', label: 'Почта', path: '/admin/mail-accounts', roles: ['admin'] },
  {
    key: 'settings',
    label: 'Настройки',
    path: '/settings',
    roles: ['admin', 'manager', 'inspector_kpp'],
  },
];

export function filterByRole(role: UserRole): NavItem[] {
  return navItems.filter((n) => n.roles.includes(role));
}
