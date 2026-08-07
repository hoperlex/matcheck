import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { authEvents, passwordResetRequests, sessions, users } from '../../db/schema.js';

/**
 * Транзакционный контекст drizzle: и сам пул, и `tx` внутри `db.transaction`
 * имеют одинаковый интерфейс, поэтому функция принимает любой из них.
 */
export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type ApplyPasswordOptions = {
  /** Кого пишем в auth_events: смена по ссылке или админский сброс. */
  event: 'password_reset_used' | 'password_set_by_admin';
  ip?: string;
  userAgent?: string | null;
  /**
   * Сессия, которую НЕ гасим. Есть только у смены пароля из личного кабинета,
   * чтобы человека не выбрасывало из активной вкладки. Для сброса — undefined:
   * там гасим всё, потому что пароль меняют как раз при подозрении на потерю
   * доступа.
   */
  keepSessionId?: string;
};

/**
 * Применяет УЖЕ ПОСЧИТАННЫЙ хэш пароля и приводит учётную запись в согласованное
 * состояние: гасит сессии, обнуляет серию неудачных входов, закрывает открытую
 * заявку на сброс.
 *
 * Почему хэш приходит снаружи. bcrypt при cost 12 считается сотни миллисекунд,
 * а проверка пароля по базе утечек ходит в сеть с таймаутом в три секунды.
 * Внутри транзакции это означало бы удерживать соединение и блокировку строки
 * всё это время, поэтому дорогие вычисления обязаны происходить ДО открытия
 * транзакции, а сюда попадает готовый результат.
 *
 * Почему принимает `tx`. Смена пароля по ссылке гасит одноразовый токен и меняет
 * пароль — это должно быть одним атомом. Если бы функция ходила через отдельное
 * соединение, токен мог сгореть при неудачной смене пароля.
 */
export async function applyPasswordHash(
  db: DbLike,
  userId: string,
  passwordHash: string,
  opts: ApplyPasswordOptions,
): Promise<void> {
  const now = new Date();

  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: now,
      // Отсекает access-токены, выданные до этого момента (сравнение по iat в
      // plugins/auth.ts) — иначе украденный токен пережил бы смену пароля.
      sessionsInvalidatedAt: now,
      // Человек только что доказал владение учёткой: копившаяся серия неудач
      // и историческая блокировка больше не имеют смысла.
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  const sessionFilter = opts.keepSessionId
    ? and(
        eq(sessions.userId, userId),
        ne(sessions.id, opts.keepSessionId),
        isNull(sessions.invalidatedAt),
      )
    : and(eq(sessions.userId, userId), isNull(sessions.invalidatedAt));
  await db.update(sessions).set({ invalidatedAt: now }).where(sessionFilter);

  // Заявка на сброс закрывается сама: пароль уже сменён, держать в админке тег
  // «Запросил сброс» не о чем.
  await db
    .update(passwordResetRequests)
    .set({ resolvedAt: now })
    .where(
      and(eq(passwordResetRequests.userId, userId), isNull(passwordResetRequests.resolvedAt)),
    );

  await db.insert(authEvents).values({
    userId,
    event: opts.event,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
  });
}

/**
 * Закрывает открытую заявку на сброс. Зовётся из обычного успешного входа: если
 * человек вспомнил пароль сам, тег в админке должен погаснуть без участия
 * администратора. По частичному уникальному индексу обычно задевает ноль строк.
 */
export async function closeOpenResetRequest(
  db: DbLike,
  userId: string,
  resolvedByUserId: string | null = null,
): Promise<void> {
  await db
    .update(passwordResetRequests)
    .set({ resolvedAt: sql`now()`, resolvedByUserId })
    .where(
      and(eq(passwordResetRequests.userId, userId), isNull(passwordResetRequests.resolvedAt)),
    );
}
