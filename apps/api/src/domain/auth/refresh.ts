import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { refreshTokens, sessions, authEvents } from '../../db/schema.js';
import { deriveReplacementToken, replacementKeyVersions, sha256Hex } from './crypto.js';
import { loadEnv } from '../../lib/env.js';

const ENV = loadEnv();

export type IssueResult = { token: string; sessionId: string; expiresAt: Date };

export type RotateResult = {
  userId: string;
  sessionId: string;
  newToken: string;
  expiresAt: Date;
  /** true — идемпотентный повтор (replay), новой ротации не было. */
  replayed: boolean;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSessionAndRefresh(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<IssueResult> {
  const token = generateOpaqueToken();
  const tokenHash = sha256Hex(token);
  const now = Date.now();
  const expiresAt = new Date(now + ENV.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  const absoluteExpiresAt = new Date(now + ENV.REFRESH_TOKEN_ABSOLUTE_MAX_DAYS * 86400_000);

  const [session] = await db
    .insert(sessions)
    .values({ userId, lastSeenIp: ip, lastSeenUa: userAgent })
    .returning();
  if (!session) throw new Error('Failed to create session');

  await db.insert(refreshTokens).values({
    sessionId: session.id,
    tokenHash,
    expiresAt,
    absoluteExpiresAt,
    ip,
    userAgent,
  });

  await db.insert(authEvents).values({
    userId,
    ip,
    userAgent,
    event: 'login_success',
  });

  return { token, sessionId: session.id, expiresAt };
}

/**
 * Ротация refresh-токена — вся целиком в одной транзакции.
 *
 * Порядок захвата блокировок ВЕЗДЕ один: sessions → refresh_tokens (тот же, что
 * в revokeBySessionId). Иначе параллельные logout и ротация встретились бы во
 * взаимной блокировке.
 *
 * Повторное предъявление уже отозванного токена больше не означает «кража»
 * автоматически: сначала пробуем идемпотентный повтор (см. tryReplay) — это
 * штатный исход потерянного ответа, а не атака.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<RotateResult | null> {
  const tokenHash = sha256Hex(presentedToken);

  return db.transaction(async (tx) => {
    // Потолок ожидания блокировки. На боевой БД statement_timeout, lock_timeout
    // и idle_in_transaction_session_timeout — нули, то есть без ограничения: если
    // event-loop API замрёт посреди этой транзакции (те самые «эпизоды», с
    // которых начался разбор), остальные refresh той же сессии ждали бы её
    // бесконечно.
    //
    // По таймауту Postgres бросит ошибку, и она обязана уйти наверх ИСКЛЮЧЕНИЕМ,
    // а не превратиться в null: null здесь означает «сессия мертва» и вызвал бы
    // ровно тот разлогин, который мы убираем. Исключение станет 500, а 500 ни
    // один клиент смертью сессии не считает — web помечает его транзиентом
    // (services/authRefresh.ts), мобильный TokenAuthenticator разлогинивает
    // только на 401.
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);

    // Первое чтение — только чтобы узнать sessionId и взять блокировку в
    // правильном порядке. Состояние токена читаем повторно уже под блокировкой.
    const [found] = await tx
      .select({ id: refreshTokens.id, sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!found) return null;

    // Блокировка сессии сериализует ротации и повторы одного клиента: без неё
    // исход гонки «повтор старого токена против ротации нового» зависел бы от
    // случайного порядка внутри Postgres.
    const [session] = await tx
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .where(and(eq(sessions.id, found.sessionId), isNull(sessions.invalidatedAt)))
      .limit(1)
      .for('update');
    // Сессия уже мертва — 401 без повторной записи reuse-события: серия
    // повторов от одного клиента иначе размножала бы одинаковые записи (на
    // проде такие серии по 3-4 события в минуту и наблюдались).
    if (!session) return null;

    const current = await readTokenState(tx, found.id);
    if (!current) return null;

    if (current.revokedAt) {
      return tryReplay(tx, current, session.userId, presentedToken, ip, userAgent);
    }
    if (current.expired) return null;

    // Id замены известен ДО вставки — из него выводится сам токен. FK на
    // replaced_by_id нет, так что проставить его в CAS раньше вставки можно.
    const replacementId = randomUUID();
    const newToken = deriveReplacementToken(presentedToken, replacementId);
    const expiresAt = new Date(Date.now() + ENV.REFRESH_TOKEN_TTL_DAYS * 86400_000);

    // CAS: отзыв старого токена — единственная точка, где решается, кто из
    // параллельных запросов «победил». Вставлять замену раньше выигранного CAS
    // нельзя — проигравший закоммитил бы лишнюю активную строку.
    // clock_timestamp(), а не now(): последний равен времени НАЧАЛА транзакции,
    // и после ожидания блокировки grace-окно отсчитывалось бы от прошлого.
    const claimed = await tx
      .update(refreshTokens)
      .set({ revokedAt: sql`clock_timestamp()`, replacedById: replacementId })
      .where(and(eq(refreshTokens.id, current.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    if (claimed.length === 0) {
      // Отозвали в обход нашей блокировки сессии (например, logout). Перечитываем
      // и идём тем же путём, что и обычный повтор.
      const after = await readTokenState(tx, current.id);
      if (!after) return null;
      return tryReplay(tx, after, session.userId, presentedToken, ip, userAgent);
    }

    const [newRow] = await tx
      .insert(refreshTokens)
      .values({
        id: replacementId,
        sessionId: current.sessionId,
        tokenHash: sha256Hex(newToken),
        expiresAt,
        absoluteExpiresAt: current.absoluteExpiresAt,
        ip,
        userAgent,
      })
      .returning({ id: refreshTokens.id });
    if (!newRow) throw new Error('Failed to create refresh row');

    await touchSession(tx, current.sessionId, ip, userAgent);

    await tx.insert(authEvents).values({
      userId: session.userId,
      event: 'refresh_success',
      ip,
      userAgent,
      meta: { sessionId: current.sessionId },
    });

    return {
      userId: session.userId,
      sessionId: current.sessionId,
      newToken,
      expiresAt,
      replayed: false,
    };
  });
}

type TokenState = {
  id: string;
  sessionId: string;
  revokedAt: Date | null;
  replacedById: string | null;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  expired: boolean;
  revokedAgeSec: number | null;
};

/**
 * Состояние токена + производные величины, посчитанные Postgres по
 * clock_timestamp(). Возраст отзыва и срок годности намеренно считаются в БД,
 * а не в Node: обе точки времени должны браться с одних часов, иначе расхождение
 * между сервером приложения и Managed PG растянуло бы или урезало grace-окно.
 */
async function readTokenState(tx: Tx, id: string): Promise<TokenState | null> {
  const [row] = await tx
    .select({
      id: refreshTokens.id,
      sessionId: refreshTokens.sessionId,
      revokedAt: refreshTokens.revokedAt,
      replacedById: refreshTokens.replacedById,
      tokenHash: refreshTokens.tokenHash,
      expiresAt: refreshTokens.expiresAt,
      absoluteExpiresAt: refreshTokens.absoluteExpiresAt,
      expired: sql<boolean>`(${refreshTokens.expiresAt} <= clock_timestamp()
        OR ${refreshTokens.absoluteExpiresAt} <= clock_timestamp())`,
      // ::double precision — иначе EXTRACT отдаёт numeric, а postgres-js
      // возвращает numeric строкой, и сравнение с числом молча сломалось бы.
      revokedAgeSec: sql<
        number | null
      >`CASE WHEN ${refreshTokens.revokedAt} IS NULL THEN NULL
             ELSE EXTRACT(epoch FROM clock_timestamp() - ${refreshTokens.revokedAt})::double precision END`,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.id, id))
    .limit(1);
  return row ?? null;
}

async function touchSession(
  tx: Tx,
  sessionId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<void> {
  await tx
    .update(sessions)
    .set({ lastSeenAt: new Date(), lastSeenIp: ip ?? null, lastSeenUa: userAgent ?? null })
    .where(eq(sessions.id, sessionId));
}

async function killSession(
  tx: Tx,
  sessionId: string,
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<null> {
  await tx.update(sessions).set({ invalidatedAt: new Date() }).where(eq(sessions.id, sessionId));
  await tx.insert(authEvents).values({
    // userId раньше не писался (сессию читали уже после ветвления) — теперь он
    // известен, и расследование «чей аккаунт трогали» не требует join'а по meta.
    userId,
    event: 'refresh_reuse_detected',
    ip,
    userAgent,
    meta: { sessionId },
  });
  return null;
}

/**
 * Повтор уже отозванного токена: потерянный ответ или кража?
 *
 * Трактуем как потерянный ответ только при совпадении ВСЕХ условий: отзыв был
 * только что, у токена есть ровно один шаг цепочки вперёд, замена жива,
 * принадлежит той же сессии и выводится из предъявленного токена серверным
 * ключом. Иначе — прежнее поведение: сессия убивается.
 *
 * Границы, принятые осознанно:
 *  - глубина цепочки ровно один шаг. Клиент, отставший на два шага (его замена
 *    уже ротирована дальше), получит 401 — редкий разлогин в обмен на то, что
 *    защита от кражи остаётся рабочей;
 *  - внутри окна вор со старым токеном тоже получит замену. Окно узкое,
 *    срок жизни не продлевается, событие пишется отдельным типом.
 */
async function tryReplay(
  tx: Tx,
  parent: TokenState,
  userId: string,
  presentedToken: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<RotateResult | null> {
  const graceSeconds = ENV.REFRESH_REUSE_GRACE_SECONDS;
  // Явная проверка нуля, а не сравнение возраста: у только что отозванного
  // токена возраст округляется к нулю, и «age <= 0» пропустило бы replay даже
  // при выключенном рубильнике.
  if (graceSeconds === 0) return killSession(tx, parent.sessionId, userId, ip, userAgent);

  if (parent.revokedAgeSec === null || parent.revokedAgeSec > graceSeconds) {
    return killSession(tx, parent.sessionId, userId, ip, userAgent);
  }
  if (!parent.replacedById) return killSession(tx, parent.sessionId, userId, ip, userAgent);

  const replacement = await readTokenState(tx, parent.replacedById);
  if (!replacement) return killSession(tx, parent.sessionId, userId, ip, userAgent);
  // Замена из другой сессии — цепочка нарушена, это не наш потерянный ответ.
  if (replacement.sessionId !== parent.sessionId) {
    return killSession(tx, parent.sessionId, userId, ip, userAgent);
  }
  // Замена сама уже отозвана — клиент отстал на два шага (см. границы выше).
  if (replacement.revokedAt) return killSession(tx, parent.sessionId, userId, ip, userAgent);
  if (replacement.expired) return killSession(tx, parent.sessionId, userId, ip, userAgent);

  // Выводим токен замены заново. Перебор версий keyring нужен, чтобы ротация
  // ключа не обрывала живые сессии: старая замена выведена прежней версией.
  let derived: string | null = null;
  for (const version of replacementKeyVersions()) {
    const candidate = deriveReplacementToken(presentedToken, replacement.id, version);
    if (sha256Hex(candidate) === replacement.tokenHash) {
      derived = candidate;
      break;
    }
  }
  // Не сошлось ни по одной версии: строка-замена выпущена не из этого токена
  // (чужой ключ, ручная правка БД, легаси-строка до этой схемы) — отдавать
  // нечего, поведение прежнее.
  if (!derived) return killSession(tx, parent.sessionId, userId, ip, userAgent);

  await touchSession(tx, parent.sessionId, ip, userAgent);
  await tx.insert(authEvents).values({
    userId,
    event: 'refresh_grace_replay',
    ip,
    userAgent,
    meta: { sessionId: parent.sessionId },
  });

  // Ротации не было: TTL замены и её absolute_expires_at остаются как есть.
  return {
    userId,
    sessionId: parent.sessionId,
    newToken: derived,
    expiresAt: replacement.expiresAt,
    replayed: true,
  };
}

export async function revokeBySessionId(sessionId: string): Promise<void> {
  await db.update(sessions).set({ invalidatedAt: new Date() }).where(eq(sessions.id, sessionId));
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
}

export async function revokeByToken(presentedToken: string): Promise<string | null> {
  const tokenHash = sha256Hex(presentedToken);
  const [existing] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (!existing) return null;
  await revokeBySessionId(existing.sessionId);
  return existing.sessionId;
}

export function refreshCookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  domain?: string;
  maxAge: number;
} {
  // __Host- prefix (prod) требует Path=/, Secure и запрещает Domain (RFC 6265bis).
  // В dev cookie без префикса — допускаем COOKIE_DOMAIN.
  const isHostPrefixed = ENV.COOKIE_SECURE;
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ENV.COOKIE_SECURE,
    ...(!isHostPrefixed && ENV.COOKIE_DOMAIN ? { domain: ENV.COOKIE_DOMAIN } : {}),
    maxAge: ENV.REFRESH_TOKEN_TTL_DAYS * 86400,
  };
}

// Legacy: до фикса refresh-cookie выпускалась с path=/api/v1/auth. На один-два
// релиза очищаем её в /auth/refresh и /auth/logout, чтобы не оставалось двух
// одноимённых cookie у пользователей.
export function legacyRefreshCookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  domain?: string;
} {
  return {
    path: '/api/v1/auth',
    httpOnly: true,
    sameSite: 'strict',
    secure: ENV.COOKIE_SECURE,
    ...(ENV.COOKIE_DOMAIN ? { domain: ENV.COOKIE_DOMAIN } : {}),
  };
}

export const REFRESH_COOKIE_NAME = ENV.COOKIE_SECURE ? '__Host-refresh' : 'refresh';

// Access-token-cookie выдаётся дополнительно к Bearer header — нужен только для тех
// клиентских механизмов, которые не умеют отправлять Authorization (нативный
// EventSource, <img>, multipart upload-formы и т.п.). Bearer header остаётся
// основным способом авторизации; cookie — fallback.
export const ACCESS_COOKIE_NAME = ENV.COOKIE_SECURE ? '__Host-access' : 'access';

export function accessCookieOptions(): {
  path: string;
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  maxAge: number;
} {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ENV.COOKIE_SECURE,
    maxAge: ENV.ACCESS_TOKEN_TTL_SECONDS,
  };
}
