import type { ComponentType } from 'react';
import {
  AppstoreOutlined,
  ControlOutlined,
  FileTextOutlined,
  InboxOutlined,
  SafetyOutlined,
  SettingOutlined,
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
  {
    key: 'settings',
    label: 'Настройки',
    path: '/settings',
    // Только для inspector_kpp: настройки распознавания УПД-PDF, PWA-кэш,
    // установка приложения — это всё про устройство инспектора. У admin
    // есть свой /admin/settings (тот же компонент в админ-меню),
    // у manager доступа не должно быть.
    roles: ['inspector_kpp'],
    icon: SettingOutlined,
  },
];

export function filterByRole(role: UserRole): NavItem[] {
  return navItems.filter((n) => n.roles.includes(role));
}
