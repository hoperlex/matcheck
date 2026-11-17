import { and, eq, inArray } from 'drizzle-orm';
import { userSites } from '../../db/schema.js';
import type { Db } from '../../db/client.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Объекты наблюдателя (user_sites) для ответов с UserDto: вход, /auth/me,
// профиль, список пользователей в админке. Скоуп на запросах берётся не
// отсюда, а из AuthUser.siteIds (plugins/auth.ts) — тот же источник в БД.

/** Объекты пользователей: id → отсортированный список. Нет строк — пустой список. */
export async function loadUserSiteIds(db: Db, userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: userSites.userId, siteId: userSites.siteId })
    .from(userSites)
    .where(inArray(userSites.userId, userIds));
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push(r.siteId);
    out.set(r.userId, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}

export async function siteIdsOfUser(db: Db, userId: string): Promise<string[]> {
  return (await loadUserSiteIds(db, [userId])).get(userId) ?? [];
}

/**
 * Заменить список объектов пользователя. Вызывать в транзакции вместе с
 * правкой пользователя. Возвращает, изменился ли набор.
 */
export async function replaceUserSites(db: Db | Tx, userId: string, siteIds: string[]): Promise<boolean> {
  const next = [...new Set(siteIds)].sort();
  const current = await db
    .select({ siteId: userSites.siteId })
    .from(userSites)
    .where(eq(userSites.userId, userId))
    .for('update');
  const prev = current.map((r) => r.siteId).sort();
  if (prev.length === next.length && prev.every((id, i) => id === next[i])) return false;
  const removed = prev.filter((id) => !next.includes(id));
  const added = next.filter((id) => !prev.includes(id));
  if (removed.length > 0) {
    await db
      .delete(userSites)
      .where(and(eq(userSites.userId, userId), inArray(userSites.siteId, removed)));
  }
  if (added.length > 0) {
    await db
      .insert(userSites)
      .values(added.map((siteId) => ({ userId, siteId })))
      .onConflictDoNothing();
  }
  return true;
}
