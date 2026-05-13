import type { ComponentType } from 'react';
import {
  AppstoreOutlined,
  BookOutlined,
  ControlOutlined,
  FileTextOutlined,
  InboxOutlined,
  SafetyOutlined,
  SettingOutlined,
  TeamOutlined,
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
    key: 'kpp',
    label: 'КПП',
    path: '/kpp',
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
    label: 'Материалы',
    path: '/materials',
    roles: ['admin', 'manager', 'inspector_kpp'],
    icon: InboxOutlined,
  },
  {
    key: 'deliveries',
    label: 'Приёмки',
    path: '/deliveries',
    roles: ['admin', 'manager', 'inspector_kpp'],
    icon: AppstoreOutlined,
  },
  {
    key: 'counterparties',
    label: 'Контрагенты',
    path: '/references/counterparties',
    roles: ['admin', 'manager'],
    icon: TeamOutlined,
  },
  {
    key: 'materials-ref',
    label: 'Справочник материалов',
    path: '/references/materials',
    roles: ['admin', 'manager'],
    icon: BookOutlined,
  },
  {
    key: 'admin',
    label: 'Администрирование',
    path: '/admin',
    roles: ['admin'],
    icon: ControlOutlined,
  },
  {
    key: 'settings',
    label: 'Настройки',
    path: '/settings',
    roles: ['manager', 'inspector_kpp'],
    icon: SettingOutlined,
  },
];

export function filterByRole(role: UserRole): NavItem[] {
  return navItems.filter((n) => n.roles.includes(role));
}
