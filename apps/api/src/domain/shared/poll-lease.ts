/**
 * Лиз на опрос внешнего источника (почтовый ящик, учётная запись ЭДО).
 *
 * Источник опрашивает ровно один экземпляр за раз: параллельный опрос означает
 * двойное скачивание и гонку за курсором. Лиз с ВЛАДЕЛЬЦЕМ и ТОКЕНОМ, а не
 * просто «занято до»: перезапущенный процесс не должен отбирать лиз у живого, а
 * «зависший» — продлевать чужой.
 *
 * Всё время берётся из now() базы, а не из часов процесса: процесс и PostgreSQL
 * живут на разных машинах, и расхождение часов иначе отдало бы источник двум
 * работникам сразу (ровно эта ошибка уже ловилась в job-outbox).
 *
 * Модуль общий, потому что у ЭДО появилось то же требование слово в слово.
 * Копия разошлась бы с оригиналом при первой же правке, а цена расхождения
 * здесь — параллельный обмен refresh_token, то есть потеря доступа к Диадоку.
 */
import { and, eq, isNull, lt, or, sql as drSql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';

export type LeaseHandle = {
  accountId: string;
  /** UUID экземпляра процесса — по нему в логах видно, кто держит источник. */
  owner: string;
  /** UUID конкретного захвата: продлить и освободить можно только им. */
  token: string;
};

/**
 * Таблица, пригодная для лиза. Набор колонок одинаков у mail_accounts и
 * edo_accounts — именно поэтому общий модуль вообще возможен.
 */
export type LeasableTable = PgTable & {
  id: PgColumn;
  isActive: PgColumn;
  pollEnabled: PgColumn;
  pollLeaseOwner: PgColumn;
  pollLeaseToken: PgColumn;
  pollLeaseUntil: PgColumn;
};

// drizzle типизирует update().set() по конкретной таблице, а модуль работает с
// любой подходящей. Приведение локальное и ограничено этим файлом.
type AnyUpdatable = Parameters<Db['update']>[0];

export async function acquirePollLease(
  db: Db,
  table: LeasableTable,
  params: {
    accountId: string;
    owner: string;
    ttlSeconds: number;
    /**
     * Требовать включённого `poll_enabled`. Автоопрос — да; ручной запуск
     * «проверить сейчас» — нет: администратору нужно проверить доступы ДО
     * того, как источник будет включён в постоянный опрос.
     */
    requirePollEnabled?: boolean;
  },
): Promise<LeaseHandle | null> {
  const token = crypto.randomUUID();
  const conditions = [
    eq(table.id, params.accountId),
    eq(table.isActive, true),
    // Свободен либо лиз истёк. Условие целиком считается базой, поэтому двум
    // работникам одновременно источник не достанется.
    or(isNull(table.pollLeaseUntil), lt(table.pollLeaseUntil, drSql`now()`)),
  ];
  if (params.requirePollEnabled !== false) {
    conditions.push(eq(table.pollEnabled, true));
  }

  const [row] = await db
    .update(table as AnyUpdatable)
    .set({
      pollLeaseOwner: params.owner,
      pollLeaseToken: token,
      pollLeaseUntil: drSql`now() + make_interval(secs => ${params.ttlSeconds})`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: table.id });

  return row ? { accountId: params.accountId, owner: params.owner, token } : null;
}

/**
 * Продлевает лиз — только своим токеном.
 *
 * `false` означает, что лиз уже перехвачен: продолжать работу с источником
 * нельзя, иначе начнётся параллельный опрос.
 */
export async function renewPollLease(
  db: Db,
  table: LeasableTable,
  lease: LeaseHandle,
  ttlSeconds: number,
): Promise<boolean> {
  const [row] = await db
    .update(table as AnyUpdatable)
    .set({
      pollLeaseUntil: drSql`now() + make_interval(secs => ${ttlSeconds})`,
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, lease.accountId), eq(table.pollLeaseToken, lease.token)))
    .returning({ id: table.id });
  return Boolean(row);
}

/**
 * Освобождает источник — тоже только своим токеном, иначе перезапустившийся
 * экземпляр снял бы лиз у того, кто прямо сейчас качает данные.
 */
export async function releasePollLease(
  db: Db,
  table: LeasableTable,
  lease: LeaseHandle,
): Promise<boolean> {
  const [row] = await db
    .update(table as AnyUpdatable)
    .set({
      pollLeaseOwner: null,
      pollLeaseToken: null,
      pollLeaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, lease.accountId), eq(table.pollLeaseToken, lease.token)))
    .returning({ id: table.id });
  return Boolean(row);
}
