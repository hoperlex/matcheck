// Лиз на опрос почтового ящика.
//
// Ящик опрашивает ровно один экземпляр воркера за раз: параллельный опрос
// приведёт к двойному скачиванию писем и гонке за watermark. Лиз с ВЛАДЕЛЬЦЕМ
// и ТОКЕНОМ, а не просто «занято до»: перезапущенный воркер не должен отбирать
// лиз у живого, а «зависший» — продлевать чужой.
//
// Всё время берётся из now() базы, а не из часов процесса: воркер и PostgreSQL
// живут на разных машинах, и расхождение часов иначе отдало бы ящик двум
// воркерам сразу (ровно эта ошибка уже ловилась в job-outbox).

import { and, eq, isNull, lt, or, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mailAccounts } from '../../db/schema.js';

export type LeaseHandle = {
  accountId: string;
  /** UUID экземпляра воркера — по нему в логах видно, кто держит ящик. */
  owner: string;
  /** UUID конкретного захвата: продлить и освободить можно только им. */
  token: string;
};

/**
 * Пытается занять ящик под опрос.
 *
 * Возвращает `null`, если ящик уже занят живым лизом или опрос для него не
 * включён — включение (`poll_enabled`) остаётся ручным действием администратора.
 */
export async function acquirePollLease(
  db: Db,
  params: { accountId: string; owner: string; ttlSeconds: number },
): Promise<LeaseHandle | null> {
  const token = crypto.randomUUID();
  const [row] = await db
    .update(mailAccounts)
    .set({
      pollLeaseOwner: params.owner,
      pollLeaseToken: token,
      pollLeaseUntil: drSql`now() + make_interval(secs => ${params.ttlSeconds})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mailAccounts.id, params.accountId),
        eq(mailAccounts.isActive, true),
        eq(mailAccounts.pollEnabled, true),
        // Свободен либо лиз истёк. Условие целиком считается базой, поэтому
        // двум воркерам одновременно ящик не достанется.
        or(isNull(mailAccounts.pollLeaseUntil), lt(mailAccounts.pollLeaseUntil, drSql`now()`)),
      ),
    )
    .returning({ id: mailAccounts.id });

  return row ? { accountId: params.accountId, owner: params.owner, token } : null;
}

/**
 * Продлевает лиз — только своим токеном.
 *
 * `false` означает, что лиз уже перехвачен другим воркером: продолжать работу
 * с ящиком нельзя, иначе начнётся параллельный опрос.
 */
export async function renewPollLease(
  db: Db,
  lease: LeaseHandle,
  ttlSeconds: number,
): Promise<boolean> {
  const [row] = await db
    .update(mailAccounts)
    .set({
      pollLeaseUntil: drSql`now() + make_interval(secs => ${ttlSeconds})`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mailAccounts.id, lease.accountId), eq(mailAccounts.pollLeaseToken, lease.token)),
    )
    .returning({ id: mailAccounts.id });
  return Boolean(row);
}

/**
 * Освобождает ящик — тоже только своим токеном, иначе перезапустившийся
 * экземпляр снял бы лиз у того, кто прямо сейчас качает письма.
 */
export async function releasePollLease(db: Db, lease: LeaseHandle): Promise<boolean> {
  const [row] = await db
    .update(mailAccounts)
    .set({
      pollLeaseOwner: null,
      pollLeaseToken: null,
      pollLeaseUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mailAccounts.id, lease.accountId), eq(mailAccounts.pollLeaseToken, lease.token)),
    )
    .returning({ id: mailAccounts.id });
  return Boolean(row);
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
