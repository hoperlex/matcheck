/**
 * Лиз на опрос учётной записи ЭДО.
 *
 * Тонкая обёртка над общим модулем — механика та же, что у почты. Отдельный
 * файл нужен, чтобы вызывающий код не таскал за собой таблицу и не мог
 * случайно взять лиз не того источника.
 *
 * Здесь лиз защищает не только от двойного скачивания: под ним же идёт обмен
 * refresh_token, а два параллельных обмена оставили бы один из процессов с
 * токеном, который сервер уже отозвал.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { edoAccounts } from '../../db/schema.js';
import {
  acquirePollLease as acquireShared,
  releasePollLease as releaseShared,
  renewPollLease as renewShared,
  type LeaseHandle,
} from '../shared/poll-lease.js';

export type { LeaseHandle } from '../shared/poll-lease.js';

export async function acquireEdoLease(
  db: Db,
  params: {
    accountId: string;
    owner: string;
    ttlSeconds: number;
    /** Ручной запуск из админки идёт с `false`: доступы проверяют до включения опроса. */
    requirePollEnabled?: boolean;
  },
): Promise<LeaseHandle | null> {
  return acquireShared(db, edoAccounts, params);
}

export async function renewEdoLease(
  db: Db,
  lease: LeaseHandle,
  ttlSeconds: number,
): Promise<boolean> {
  return renewShared(db, edoAccounts, lease, ttlSeconds);
}

export async function releaseEdoLease(db: Db, lease: LeaseHandle): Promise<boolean> {
  return releaseShared(db, edoAccounts, lease);
}

/** Учётные записи, подлежащие автоматическому опросу. Лиз не берёт. */
export async function listPollableEdoAccounts(
  db: Db,
): Promise<(typeof edoAccounts.$inferSelect)[]> {
  return db
    .select()
    .from(edoAccounts)
    .where(and(eq(edoAccounts.isActive, true), eq(edoAccounts.pollEnabled, true)));
}
