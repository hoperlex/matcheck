import { create } from 'zustand';
import type { PermissionSet } from '../shared/utils/permissions';

/**
 * Права текущего пользователя, как их отдал сервер.
 *
 * `perms === null` означает «ещё не знаем», а НЕ «ничего нельзя»: пока прав
 * нет, интерфейс работает по дефолтам роли (shared/utils/permissions.ts).
 * Поэтому очищать стор при выходе обязательно — иначе следующий пользователь
 * во вкладке первые секунды видел бы чужое меню.
 *
 * userId хранится рядом с правами: он единственный способ заметить, что стор
 * достался от предыдущего пользователя (запись сверяется с ним в
 * permissionsSync.ts).
 */
type PermissionsState = {
  userId: string | null;
  perms: PermissionSet | null;
  /** Момент успешной загрузки — по нему планировщик решает, не пора ли обновить. */
  loadedAt: number | null;
  set: (userId: string, perms: PermissionSet) => void;
  clear: () => void;
};

export const usePermissionsStore = create<PermissionsState>((set) => ({
  userId: null,
  perms: null,
  loadedAt: null,
  set: (userId, perms) => set({ userId, perms, loadedAt: Date.now() }),
  clear: () => set({ userId: null, perms: null, loadedAt: null }),
}));
