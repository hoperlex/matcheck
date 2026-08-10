import type { ComponentType } from 'react';
import {
  AppstoreOutlined,
  BarChartOutlined,
  ControlOutlined,
  FileTextOutlined,
  InboxOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import type { PageGroup, UserRole } from '@matcheck/contracts';
import { canViewGroup, type PermissionSet } from '../../shared/utils/permissions';

export type NavItem = {
  key: string;
  label: string;
  path: string;
  /**
   * Роли, которым пункт виден «как раньше».
   *
   * Дублирует дефолт матрицы (PAGE_CATALOG[].base) и остаётся здесь
   * намеренно: это единственный способ проверить, что переход на права ничего
   * не изменил в день выката. Расхождение ловит инвариант-тест
   * navItems.test.ts — если он упал, разъехались дефолт и навигация, и
   * чинить нужно то, что отстало, а не тест.
   */
  roles: UserRole[];
  /** Раздел матрицы прав. Пункт виден, если видна хоть одна его страница. */
  group: PageGroup;
  icon: ComponentType;
};

export const navItems: NavItem[] = [
  {
    key: 'operations',
    label: 'Операции',
    path: '/operations',
    // monitor (мониторинг качества) видит только «Операции» — просматривает
    // все приёмки/отгрузки и ставит отметку проверки. Отчёты/справочники/
    // админка ему не открыты (отдельные пункты его роль не включают).
    roles: ['admin', 'manager', 'inspector_kpp', 'contractor', 'monitor'],
    group: 'operations',
    icon: SafetyOutlined,
  },
  {
    key: 'documents',
    label: 'Документы',
    path: '/documents',
    roles: ['admin', 'manager', 'contractor'],
    group: 'documents',
    icon: FileTextOutlined,
  },
  {
    key: 'materials',
    label: 'История поступлений',
    path: '/materials',
    roles: ['admin', 'manager', 'inspector_kpp'],
    group: 'materials',
    icon: InboxOutlined,
  },
  {
    key: 'stats',
    label: 'Статистика',
    path: '/stats',
    // Аналитика для руководителя: admin + manager. Инспектор свою
    // выработку не видит — это раздел уровнем «над» поступлениями.
    roles: ['admin', 'manager'],
    group: 'stats',
    icon: BarChartOutlined,
  },
  {
    key: 'references',
    label: 'Справочники',
    path: '/references',
    roles: ['admin', 'manager'],
    group: 'references',
    icon: AppstoreOutlined,
  },
  {
    key: 'admin',
    label: 'Администрирование',
    path: '/admin',
    roles: ['admin'],
    group: 'admin',
    icon: ControlOutlined,
  },
  // Раздел «Настройки» (/settings) в основной навигации не показываем
  // никому: способ распознавания УПД фиксируется на стороне сервера
  // (дефолт — LLM, управляет admin через /admin/settings), а локальное
  // хранение по умолчанию «Все данные». Ни manager, ни inspector_kpp
  // переопределять это вручную не должны.
];

/**
 * Прежняя фильтрация по роли. Остаётся как эталон для инвариант-теста: она
 * описывает поведение ДО матрицы, и до включения PERMISSIONS_ENFORCE результат
 * filterByPermissions обязан совпадать с ней ячейка в ячейку.
 */
export function filterByRole(role: UserRole): NavItem[] {
  return navItems.filter((n) => n.roles.includes(role));
}

/**
 * Меню по правам. `perms === null` (ещё не загрузились/не смогли) — не повод
 * прятать пункты: сработает дефолт роли внутри canViewGroup.
 */
export function filterByPermissions(perms: PermissionSet | null, role?: UserRole): NavItem[] {
  return navItems.filter((n) => canViewGroup(perms, n.group, role));
}

/**
 * Куда вести человека с корня и после отказа в доступе — первый доступный ему
 * раздел.
 *
 * Без этого index-роут ведёт на /operations жёстко, и человеку без доступа к
 * операциям (например, менеджеру, которому оставили только справочники) корень
 * отдаёт редирект на закрытую страницу, та — обратно на корень: бесконечный
 * цикл вместо интерфейса.
 */
export function homePath(perms: PermissionSet | null, role?: UserRole): string | null {
  return filterByPermissions(perms, role)[0]?.path ?? null;
}
