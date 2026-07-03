import type { UserRole } from '@matcheck/contracts';

// Человекочитаемые названия ролей для UI (админка, шапка мобилы). Раньше роль
// выводилась сырой строкой ('inspector_kpp'), что нечитаемо для пользователя.
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  inspector_kpp: 'Инспектор КПП',
  contractor: 'Подрядчик',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}
