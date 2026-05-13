import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { refreshTokens, sessions, authEvents } from '../../db/schema.js';
import { sha256Hex } from './crypto.js';
import { loadEnv } from '../../lib/env.js';

const ENV = loadEnv();

export type IssueResult = { token: string; sessionId: string; expiresAt: Date };

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

export async function rotateRefreshToken(
  presentedToken: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<{ userId: string; sessionId: string; newToken: string; expiresAt: Date } | null> {
  const tokenHash = sha256Hex(presentedToken);
  const [existing] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  if (!existing) return null;

  // Reuse detection: token already revoked
  if (existing.revokedAt) {
    // Revoke entire session chain + alert
    await db
      .update(sessions)
      .set({ invalidatedAt: new Date() })
      .where(eq(sessions.id, existing.sessionId));
    await db.insert(authEvents).values({
      event: 'refresh_reuse_detected',
      ip,
      userAgent,
      meta: { sessionId: existing.sessionId },
    });
    return null;
  }

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, existing.sessionId), isNull(sessions.invalidatedAt)))
    .limit(1);
  if (!session) return null;

  if (existing.expiresAt < new Date() || existing.absoluteExpiresAt < new Date()) {
    return null;
  }

  const newToken = generateOpaqueToken();
  const newHash = sha256Hex(newToken);
  const now = Date.now();
  const expiresAt = new Date(now + ENV.REFRESH_TOKEN_TTL_DAYS * 86400_000);

  const [newRow] = await db
    .insert(refreshTokens)
    .values({
      sessionId: existing.sessionId,
      tokenHash: newHash,
      expiresAt,
      absoluteExpiresAt: existing.absoluteExpiresAt,
      ip,
      userAgent,
    })
    .returning();
  if (!newRow) throw new Error('Failed to create refresh row');

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedById: newRow.id })
    .where(eq(refreshTokens.id, existing.id));

  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(), lastSeenIp: ip ?? null, lastSeenUa: userAgent ?? null })
    .where(eq(sessions.id, existing.sessionId));

  await db.insert(authEvents).values({
    userId: session.userId,
    event: 'refresh_success',
    ip,
    userAgent,
    meta: { sessionId: existing.sessionId },
  });

  return { userId: session.userId, sessionId: existing.sessionId, newToken, expiresAt };
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
  return {
    path: '/api/v1/auth',
    httpOnly: true,
    sameSite: 'strict',
    secure: ENV.COOKIE_SECURE,
    ...(ENV.COOKIE_DOMAIN ? { domain: ENV.COOKIE_DOMAIN } : {}),
    maxAge: ENV.REFRESH_TOKEN_TTL_DAYS * 86400,
  };
}

export const REFRESH_COOKIE_NAME = ENV.COOKIE_SECURE ? '__Host-refresh' : 'refresh';
