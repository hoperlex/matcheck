/**
 * Аварийный рубильник: REFRESH_REUSE_GRACE_SECONDS=0 возвращает прежнее
 * поведение — любое повторное предъявление отозванного токена убивает сессию.
 *
 * Почему отдельный файл, а не случай в refresh-rotation.int.test.ts: значение
 * читается ровно один раз — loadEnv() кэширует результат (lib/env.ts), а
 * domain/auth/refresh.ts забирает ENV на импорте модуля. Правка process.env
 * между тестами внутри одного файла не подействовала бы, и тест «рубильник
 * выключает повтор» молча проверял бы включённый рубильник.
 *
 * Запуск (см. подробности в refresh-rotation.int.test.ts):
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/refresh-rotation-grace-off.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';

// ДО импортов приложения: и подмена базы, и сам рубильник — иначе loadEnv()
// успеет закэшировать умолчание 60.
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.REFRESH_REUSE_GRACE_SECONDS = '0';
});

import postgres from 'postgres';
import { hashPassword } from '../../src/domain/auth/password.js';
import { createSessionAndRefresh, rotateRefreshToken } from '../../src/domain/auth/refresh.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const PASSWORD = 'Correct-Horse-9!';
const IP = '10.0.0.1';
const UA = 'vitest';

suite('REFRESH_REUSE_GRACE_SECONDS=0 — повтор выключен (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;

  const userId = randomUUID();
  const email = `refresh-off-${userId}@example.com`;

  const sessionAlive = async (sessionId: string) => {
    const [row] = await sql<{ invalidated_at: Date | null }[]>`
      SELECT invalidated_at FROM sessions WHERE id = ${sessionId}`;
    return row!.invalidated_at === null;
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 2 });
    const hash = await hashPassword(PASSWORD);
    await sql`INSERT INTO users (id, email, password_hash, role, is_active)
      VALUES (${userId}, ${email}, ${hash}, 'manager', true)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM refresh_tokens WHERE session_id IN
      (SELECT id FROM sessions WHERE user_id = ${userId})`;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await sql`DELETE FROM auth_events WHERE user_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('повтор сразу после ротации всё равно убивает сессию', async () => {
    // При включённом окне (умолчание 60с) этот же повтор вернул бы 200 —
    // отличие ровно в рубильнике, а не в тайминге.
    const issued = await createSessionAndRefresh(userId, IP, UA);
    await rotateRefreshToken(issued.token, IP, UA);

    const again = await rotateRefreshToken(issued.token, IP, UA);

    expect(again).toBeNull();
    expect(await sessionAlive(issued.sessionId)).toBe(false);
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM auth_events
      WHERE event = 'refresh_grace_replay' AND meta->>'sessionId' = ${issued.sessionId}`;
    expect(Number(row!.n)).toBe(0);
  });

  it('обычная ротация при выключенном повторе работает как раньше', async () => {
    const issued = await createSessionAndRefresh(userId, IP, UA);

    const rotated = await rotateRefreshToken(issued.token, IP, UA);

    expect(rotated).not.toBeNull();
    expect(rotated!.replayed).toBe(false);
    expect(await sessionAlive(issued.sessionId)).toBe(true);
  });
});
