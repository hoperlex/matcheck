// Лиз на опрос почтового ящика.
//
// Механика вынесена в domain/shared/poll-lease.ts: ровно то же требование
// появилось у учётных записей ЭДО, а две копии разошлись бы при первой правке.
// Здесь остались прежние сигнатуры — вызывающий код и тесты почты не меняются,
// и их прогон как раз и доказывает, что вынос ничего не сломал.

import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mailAccounts } from '../../db/schema.js';
import {
  acquirePollLease as acquireShared,
  releasePollLease as releaseShared,
  renewPollLease as renewShared,
  type LeaseHandle,
} from '../shared/poll-lease.js';

export type { LeaseHandle } from '../shared/poll-lease.js';

/**
 * Пытается занять ящик под опрос.
 *
 * Возвращает `null`, если ящик уже занят живым лизом или опрос для него не
 * включён — включение (`poll_enabled`) остаётся ручным действием администратора.
 */
export async function acquirePollLease(
  db: Db,
  params: {
    accountId: string;
    owner: string;
    ttlSeconds: number;
    /**
     * Требовать включённого `poll_enabled`. Автоопрос — да; ручной запуск
     * «проверить сейчас» — нет: администратору нужно проверить доступы ДО
     * того, как ящик будет включён в постоянный опрос.
     */
    requirePollEnabled?: boolean;
  },
): Promise<LeaseHandle | null> {
  return acquireShared(db, mailAccounts, params);
}

export async function renewPollLease(
  db: Db,
  lease: LeaseHandle,
  ttlSeconds: number,
): Promise<boolean> {
  return renewShared(db, mailAccounts, lease, ttlSeconds);
}

export async function releasePollLease(db: Db, lease: LeaseHandle): Promise<boolean> {
  return releaseShared(db, mailAccounts, lease);
}

/**
 * Ящики, которые вообще подлежат опросу. Ничего не захватывает — только
 * перечисляет кандидатов, чтобы поллер прошёл по ним и попробовал взять лиз.
 */
export async function listPollableAccounts(db: Db): Promise<(typeof mailAccounts.$inferSelect)[]> {
  return db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.isActive, true), eq(mailAccounts.pollEnabled, true)));
}
