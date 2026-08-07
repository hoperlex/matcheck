/**
 * Самообслуживаемый сброс пароля: заявка от человека, ссылка от админа, смена
 * пароля по ссылке.
 *
 * Зачем интеграционные: всё существенное живёт в SQL и в конкурентном доступе —
 * атомарный захват одноразового токена, уникальный индекс «одна открытая ссылка
 * на пользователя», full join заявок и токенов. На моках проверялась бы выдумка.
 *
 * Приложение собирается в БОЕВОЙ форме, с настоящим authPlugin: без него
 * проверка «админский роут без токена → 401» была бы бутафорской — глобальный
 * guard живёт именно в плагине, а не в самих роутах.
 *
 * Запуск (нужна тестовая БД с миграцией 0090):
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration/password-reset.int.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// До импорта модулей приложения: db/client.ts открывает пул на импорте, а
// PUBLIC_BASE_URL нужен уже при построении первой ссылки.
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://portal.test';
  process.env.AUTH_BACKOFF_BASE_MS = '1';
});

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import authPlugin from '../../src/plugins/auth.js';
import { authRoutes } from '../../src/routes/auth.js';
import { publicPasswordResetRoutes } from '../../src/routes/public-password-reset.js';
import { passwordResetAdminRoutes } from '../../src/routes/admin/password-resets.js';
import {
  authEvents,
  passwordResetRequests,
  passwordResetTokens,
  refreshTokens,
  sessions,
  unauthorizedAccessLog,
  users,
} from '../../src/db/schema.js';
import { hashPassword } from '../../src/domain/auth/password.js';
import { signAccessToken } from '../../src/domain/auth/jwt.js';
import { registerErrorHandler } from '../../src/lib/error-handler.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OLD_PASSWORD = 'Old-Horse-Battery-9!';
const NEW_PASSWORD = 'Fresh-Tundra-Wolf-42!';

suite('Сброс пароля по ссылке (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;

  const targetId = randomUUID();
  const adminId = randomUUID();
  const managerId = randomUUID();
  const targetEmail = `target-${targetId}@example.com`;
  const adminEmail = `admin-${adminId}@example.com`;
  const managerEmail = `manager-${managerId}@example.com`;
  let adminToken = '';
  let managerToken = '';

  const asAdmin = (method: 'GET' | 'POST', url: string) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${adminToken}` } });

  const publicPost = (path: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/public/password-reset/${path}`, payload });

  const tokenOf = (url: string) => url.split('#')[1]!;

  const issueLinkForTarget = async () => {
    const res = await asAdmin('POST', `/api/v1/admin/users/${targetId}/password-reset-link`);
    expect(res.statusCode).toBe(200);
    return res.json() as { linkId: string; url: string; expiresAt: string };
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    const db = drizzle(sql, {
      schema: {
        users,
        sessions,
        refreshTokens,
        authEvents,
        passwordResetRequests,
        passwordResetTokens,
        unauthorizedAccessLog,
      },
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);
    await app.register(cookie);
    app.decorate('db', db as never);
    // Настоящий плагин, а не заглушка: он и есть глобальный guard.
    await app.register(authPlugin);
    await app.register(authRoutes);
    await app.register(publicPasswordResetRoutes);
    await app.register(passwordResetAdminRoutes);
    // Лимитеры пропускаются при недоступном Redis (fail-open), поэтому в
    // стенде его нет: проверка самих лимитов — отдельная задача.
    app.decorate('redis', {
      incr: async () => {
        throw new Error('redis disabled in test');
      },
    } as never);
    await app.ready();

    const hash = await hashPassword(OLD_PASSWORD);
    await sql`INSERT INTO users (id, email, password_hash, role, is_active) VALUES
      (${targetId}, ${targetEmail}, ${hash}, 'manager', true),
      (${adminId}, ${adminEmail}, ${hash}, 'admin', true),
      (${managerId}, ${managerEmail}, ${hash}, 'manager', true)`;

    const adminSession = randomUUID();
    const managerSession = randomUUID();
    await sql`INSERT INTO sessions (id, user_id) VALUES
      (${adminSession}, ${adminId}), (${managerSession}, ${managerId})`;
    adminToken = await signAccessToken({
      sub: adminId,
      role: 'admin',
      sid: adminSession,
      aal: 'aal1',
    });
    managerToken = await signAccessToken({
      sub: managerId,
      role: 'manager',
      sid: managerSession,
      aal: 'aal1',
    });
  });

  beforeEach(async () => {
    await sql`DELETE FROM password_reset_tokens WHERE user_id = ${targetId}`;
    await sql`DELETE FROM password_reset_requests WHERE user_id = ${targetId}`;
    await sql`UPDATE users SET password_hash = ${await hashPassword(OLD_PASSWORD)},
      sessions_invalidated_at = NULL, failed_login_count = 0, locked_until = NULL,
      last_failed_login_at = NULL WHERE id = ${targetId}`;
    await sql`UPDATE sessions SET invalidated_at = NULL WHERE user_id = ${targetId}`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    const ids = [targetId, adminId, managerId];
    await sql`DELETE FROM password_reset_tokens WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM password_reset_requests WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM refresh_tokens WHERE session_id IN
      (SELECT id FROM sessions WHERE user_id = ANY(${ids}))`;
    await sql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM auth_events WHERE user_id = ANY(${ids})`;
    await sql`DELETE FROM users WHERE id = ANY(${ids})`;
    await sql.end({ timeout: 5 });
  });

  // ─── Заявка ──────────────────────────────────────────────────────────────

  it('заявка по существующему email создаётся, по неизвестному — тот же ответ и пусто в БД', async () => {
    const known = await publicPost('request', { email: targetEmail });
    const unknown = await publicPost('request', { email: 'nobody-here@example.com' });

    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    // Тело обязано совпадать: иначе форма превращается в проверялку «есть ли у
    // них такой сотрудник».
    expect(known.json()).toEqual(unknown.json());

    const rows = await sql`SELECT user_id FROM password_reset_requests WHERE user_id = ${targetId}`;
    expect(rows).toHaveLength(1);
  });

  it('повторная заявка не плодит строки', async () => {
    await publicPost('request', { email: targetEmail });
    await publicPost('request', { email: targetEmail });
    const rows = await sql`SELECT id FROM password_reset_requests
      WHERE user_id = ${targetId} AND resolved_at IS NULL`;
    expect(rows).toHaveLength(1);
  });

  it('заявка НЕ отзывает уже выданную ссылку и не создаёт токен', async () => {
    const link = await issueLinkForTarget();
    await publicPost('request', { email: targetEmail });

    // Иначе любой, знающий чужой email, гасил бы отправленные ссылки.
    const inspect = await publicPost('inspect', { token: tokenOf(link.url) });
    expect(inspect.statusCode).toBe(200);
    const tokens = await sql`SELECT id FROM password_reset_tokens WHERE user_id = ${targetId}`;
    expect(tokens).toHaveLength(1);
  });

  // ─── Выдача ссылки ───────────────────────────────────────────────────────

  it('ссылка ведёт на фрагмент доверенного домена, токена в пути нет', async () => {
    const link = await issueLinkForTarget();
    expect(link.url.startsWith('https://portal.test/reset-password#')).toBe(true);
    // Токен только после '#': путь уходит в логи прокси и Referer, фрагмент — нет.
    expect(new URL(link.url).pathname).toBe('/reset-password');
  });

  it('две параллельные выдачи возвращают ОДНУ И ТУ ЖЕ действующую ссылку', async () => {
    const [a, b] = await Promise.all([
      asAdmin('POST', `/api/v1/admin/users/${targetId}/password-reset-link`),
      asAdmin('POST', `/api/v1/admin/users/${targetId}/password-reset-link`),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    // Проверяем именно ответы, а не только число строк: без идемпотентности
    // второй запрос отозвал бы ссылку первого, и админ скопировал бы мёртвую.
    expect(a.json().url).toBe(b.json().url);

    const alive = await sql`SELECT id FROM password_reset_tokens
      WHERE user_id = ${targetId} AND used_at IS NULL AND revoked_at IS NULL`;
    expect(alive).toHaveLength(1);

    const inspect = await publicPost('inspect', { token: tokenOf(a.json().url) });
    expect(inspect.statusCode).toBe(200);
  });

  it('rotate выдаёт новую и гасит прежнюю, повторный rotate по той же — 409', async () => {
    const first = await issueLinkForTarget();
    const rotated = await asAdmin(
      'POST',
      `/api/v1/admin/password-resets/${first.linkId}/rotate`,
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().url).not.toBe(first.url);

    // Прежняя мертва.
    expect((await publicPost('inspect', { token: tokenOf(first.url) })).statusCode).toBe(404);

    // Повторный клик по уже отозванной — конфликт, а не вторая новая ссылка.
    const again = await asAdmin('POST', `/api/v1/admin/password-resets/${first.linkId}/rotate`);
    expect(again.statusCode).toBe(409);
    const alive = await sql`SELECT id FROM password_reset_tokens
      WHERE user_id = ${targetId} AND used_at IS NULL AND revoked_at IS NULL`;
    expect(alive).toHaveLength(1);
  });

  it('reveal отдаёт ту же ссылку, revoke её убивает', async () => {
    const link = await issueLinkForTarget();
    const revealed = await asAdmin('POST', `/api/v1/admin/password-resets/${link.linkId}/reveal`);
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().url).toBe(link.url);

    const revoked = await asAdmin('POST', `/api/v1/admin/password-resets/${link.linkId}/revoke`);
    expect(revoked.statusCode).toBe(200);
    // Мёртвую ссылку не показываем: она бесполезна, а лишний показ секрета — след.
    expect(
      (await asAdmin('POST', `/api/v1/admin/password-resets/${link.linkId}/reveal`)).statusCode,
    ).toBe(404);
    expect((await publicPost('inspect', { token: tokenOf(link.url) })).statusCode).toBe(404);
  });

  it('протухшая ссылка недействительна во всех трёх точках', async () => {
    const link = await issueLinkForTarget();
    await sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
      WHERE id = ${link.linkId}`;

    expect((await publicPost('inspect', { token: tokenOf(link.url) })).statusCode).toBe(404);
    expect(
      (await publicPost('consume', { token: tokenOf(link.url), newPassword: NEW_PASSWORD }))
        .statusCode,
    ).toBe(404);
    expect(
      (await asAdmin('POST', `/api/v1/admin/password-resets/${link.linkId}/reveal`)).statusCode,
    ).toBe(404);
  });

  it('новая выдача гасит протухшую, не спотыкаясь об уникальный индекс', async () => {
    const stale = await issueLinkForTarget();
    await sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'
      WHERE id = ${stale.linkId}`;

    // Индекс считает открытыми любые записи без used_at/revoked_at — срок он не
    // учитывает, поэтому протухшую обязательно надо отозвать.
    const fresh = await issueLinkForTarget();
    expect(fresh.linkId).not.toBe(stale.linkId);
    const open = await sql`SELECT id FROM password_reset_tokens
      WHERE user_id = ${targetId} AND used_at IS NULL AND revoked_at IS NULL`;
    expect(open).toHaveLength(1);
  });

  // ─── Смена пароля ────────────────────────────────────────────────────────

  it('смена пароля: новый работает, старый нет, сессии погашены, заявка закрыта', async () => {
    await publicPost('request', { email: targetEmail });
    const link = await issueLinkForTarget();
    const liveSession = randomUUID();
    await sql`INSERT INTO sessions (id, user_id) VALUES (${liveSession}, ${targetId})`;

    const res = await publicPost('consume', {
      token: tokenOf(link.url),
      newPassword: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(200);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: targetEmail, password: NEW_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    const old = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: targetEmail, password: OLD_PASSWORD },
    });
    expect(old.statusCode).toBe(401);

    const [session] = await sql<{ invalidated_at: Date | null }[]>`
      SELECT invalidated_at FROM sessions WHERE id = ${liveSession}`;
    expect(session!.invalidated_at).not.toBeNull();

    const open = await sql`SELECT id FROM password_reset_requests
      WHERE user_id = ${targetId} AND resolved_at IS NULL`;
    expect(open).toHaveLength(0);
  });

  it('два параллельных consume одним токеном — ровно один успех', async () => {
    const link = await issueLinkForTarget();
    const token = tokenOf(link.url);

    const [a, b] = await Promise.all([
      publicPost('consume', { token, newPassword: NEW_PASSWORD }),
      publicPost('consume', { token, newPassword: 'Second-Attempt-Pass-77!' }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 404]);

    // Победил ровно один — и пароль в базе именно его.
    const winner = a.statusCode === 200 ? NEW_PASSWORD : 'Second-Attempt-Pass-77!';
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: targetEmail, password: winner },
    });
    expect(login.statusCode).toBe(200);
  });

  it('использованная ссылка больше не работает', async () => {
    const link = await issueLinkForTarget();
    const token = tokenOf(link.url);
    expect((await publicPost('consume', { token, newPassword: NEW_PASSWORD })).statusCode).toBe(200);
    expect(
      (await publicPost('consume', { token, newPassword: 'Third-Try-Password-9!' })).statusCode,
    ).toBe(404);
  });

  it('слабый пароль отклоняется, ссылка при этом остаётся живой', async () => {
    const link = await issueLinkForTarget();
    const token = tokenOf(link.url);
    const weak = await publicPost('consume', { token, newPassword: 'password' });
    expect(weak.statusCode).toBe(400);
    // Ссылка не должна сгорать из-за неудачной попытки — человеку ещё
    // придумывать пароль.
    expect((await publicPost('inspect', { token })).statusCode).toBe(200);
  });

  // ─── Заявка закрывается сама ─────────────────────────────────────────────

  it('обычный успешный вход закрывает открытую заявку', async () => {
    await publicPost('request', { email: targetEmail });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: targetEmail, password: OLD_PASSWORD },
    });
    expect(login.statusCode).toBe(200);

    // Человек вспомнил пароль сам — тег «Запросил сброс» не должен висеть вечно.
    const open = await sql`SELECT id FROM password_reset_requests
      WHERE user_id = ${targetId} AND resolved_at IS NULL`;
    expect(open).toHaveLength(0);
  });

  // ─── Админский список и доступ ───────────────────────────────────────────

  it('список отдаёт метаданные с идентификаторами и НЕ содержит секретов', async () => {
    await publicPost('request', { email: targetEmail });
    const link = await issueLinkForTarget();

    const res = await asAdmin('GET', '/api/v1/admin/password-resets');
    expect(res.statusCode).toBe(200);
    const row = (res.json().items as Array<Record<string, unknown>>).find(
      (r) => r.userId === targetId,
    );
    expect(row).toMatchObject({ linkId: link.linkId, hasActiveLink: true });
    expect(row!.requestId).toBeTruthy();
    // Ключи от всех аккаунтов не должны ехать в браузер списком.
    expect(res.body).not.toContain('reset-password#');
    expect(res.body).not.toContain('tokenEncrypted');
  });

  it('reveal пишет след в аудит', async () => {
    const link = await issueLinkForTarget();
    await asAdmin('POST', `/api/v1/admin/password-resets/${link.linkId}/reveal`);
    const events = await sql`SELECT event FROM auth_events
      WHERE event = 'password_reset_link_revealed' AND ts > now() - interval '1 minute'`;
    expect(events.length).toBeGreaterThan(0);
  });

  it('доступ к админской изнанке: 401 без токена, 403 не-админу, 200 админу', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/admin/password-resets' });
    expect(anon.statusCode).toBe(401);

    const nonAdmin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/password-resets',
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(nonAdmin.statusCode).toBe(403);

    expect((await asAdmin('GET', '/api/v1/admin/password-resets')).statusCode).toBe(200);
  });

  it('закрытие заявки админом убирает её из списка', async () => {
    await publicPost('request', { email: targetEmail });
    const before = await asAdmin('GET', '/api/v1/admin/password-resets');
    const requestId = (before.json().items as Array<Record<string, string>>).find(
      (r) => r.userId === targetId,
    )!.requestId;

    const closed = await asAdmin(
      'POST',
      `/api/v1/admin/password-resets/requests/${requestId}/close`,
    );
    expect(closed.statusCode).toBe(200);

    const after = await asAdmin('GET', '/api/v1/admin/password-resets');
    const row = (after.json().items as Array<Record<string, unknown>>).find(
      (r) => r.userId === targetId,
    );
    expect(row?.requestId ?? null).toBeNull();
  });
});
