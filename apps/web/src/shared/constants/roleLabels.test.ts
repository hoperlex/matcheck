/**
 * Словарь названий ролей обязан покрывать все роли контракта.
 *
 * `ROLE_LABELS` типизирован как `Record<UserRole, string>`, но опираться на это
 * нельзя: `pnpm typecheck` в apps/web поднимает корневой tsconfig с
 * `"files": []` и не проверяет ни одного файла. То есть забытая роль не даст ни
 * ошибки компиляции, ни падения — пользователь просто увидит в админке сырое
 * `observer` вместо «Наблюдатель». Отсюда тест.
 */
import { describe, expect, it } from 'vitest';
import { UserRoleSchema } from '@matcheck/contracts';
import { ROLE_LABELS, roleLabel } from './roleLabels';

describe('названия ролей', () => {
  it('для каждой роли контракта есть человекочитаемое название', () => {
    for (const role of UserRoleSchema.options) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      // Сырой идентификатор в интерфейсе — это и есть забытая роль.
      expect(ROLE_LABELS[role], role).not.toBe(role);
    }
  });

  it('лишних ключей нет', () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...UserRoleSchema.options].sort());
  });

  it('наблюдатель назван по-русски', () => {
    expect(roleLabel('observer')).toBe('Наблюдатель');
  });
});
