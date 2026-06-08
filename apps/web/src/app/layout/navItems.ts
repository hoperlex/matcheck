import type { ComponentType } from 'react';
import {
  AppstoreOutlined,
  BarChartOutlined,
  ControlOutlined,
  FileTextOutlined,
  InboxOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import type { UserRole } from '@matcheck/contracts';

export type NavItem = {
  key: string;
  label: string;
  path: string;
  roles: UserRole[];
  icon: ComponentType;
};

export const navItems: NavItem[] = [
  {
    key: 'operations',
    label: 'Операции',
    path: '/operations',
    roles: ['admin', 'manager', 'inspector_kpp'],
    icon: SafetyOutlined,
  },
  {
    key: 'documents',
    label: 'Документы',
    path: '/documents',
    roles: ['admin', 'manager'],
    icon: FileTextOutlined,
  },
  {
    key: 'materials',
    label: 'История поступлений',
    path: '/materials',
    roles: ['admin', 'manager', 'inspector_kpp'],
    icon: InboxOutlined,
  },
  {
    key: 'stats',
    label: 'Статистика',
    path: '/stats',
    // Аналитика для руководителя: admin + manager. Инспектор свою
    // выработку не видит — это раздел уровнем «над» поступлениями.
    roles: ['admin', 'manager'],
    icon: BarChartOutlined,
  },
  {
    key: 'references',
    label: 'Справочники',
    path: '/references',
    roles: ['admin', 'manager'],
    icon: AppstoreOutlined,
  },
  {
    key: 'admin',
    label: 'Администрирование',
    path: '/admin',
    roles: ['admin'],
    icon: ControlOutlined,
  },
  // Раздел «Настройки» (/settings) в основной навигации не показываем
  // никому: способ распознавания УПД фиксируется на стороне сервера
  // (дефолт — LLM, управляет admin через /admin/settings), а локальное
  // хранение по умолчанию «Все данные». Ни manager, ни inspector_kpp
  // переопределять это вручную не должны.
];

export function filterByRole(role: UserRole): NavItem[] {
  return navItems.filter((n) => n.roles.includes(role));
}
