/**
 * Вкладка «Администрирование → API-доступ» на настоящем PostgreSQL.
 *
 * Права на уже выданном токене (снятие — сразу, добавление — с нового токена),
 * новый секрет с защитой от двойного нажатия и гонкой двух ротаций, ротация
 * против отзыва, повторный отзыв без сдвига revoked_at, срок действия, сети после
 * правки, «последний запрос» не чаще раза в минуту, журнал атомарно с изменением
 * (сбой журнала откатывает изменение), отказ не-администратору.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import { apiKeyRoutes } from '../../src/routes/admin/api-keys.js';
import {
  issueMachineToken,
  resolveServicePrincipal,
  SCOPE_ONEC_ACK,
  SCOPE_ONEC_READ,
} from '../../src/domain/auth/service-accounts.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const NAME = (s: string) => `ключ-тест-${RUN}-${s}`;
const IP = '203.0.113.10';

type KeyDto = {
  id: string;
  clientId: string;
  name: string;
  status: string;
  allowAck: boolean;
  allowedCidrs: string[] | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdByName: string | null;
  secretGeneration: number;
  scopes: string[];
};

suite('API-доступ: ключи 1С (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let app: FastifyInstance;
  let currentUser: AuthUser;
  const adminId = randomUUID();
  const managerId = randomUUID();

  const as = (id: string, role: AuthUser['role']): AuthUser =>
    ({ id, role, siteId: null, contractorCustomerId: null, sessionId: 'sess' }) as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 6 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (req: { user?: AuthUser }, reply: { code: (c: number) => { send: (b: unknown) => void } }) => {
          if (!req.user || !roles.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
        },
    );
    await app.register(apiKeyRoutes);
    await app.ready();
    await sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES
      (${adminId}, ${`a-${RUN}@t.local`}, 'x', 'admin', 'Админ Ключей'),
      (${managerId}, ${`m-${RUN}@t.local`}, 'x', 'manager', 'Менеджер Ключей')`;
  });

  async function clean() {
    const ids = await sql<{ id: string; client_id: string }[]>`
      SELECT id, client_id FROM service_accounts WHERE name LIKE ${`ключ-тест-${RUN}-%`}`;
    if (ids.length === 0) return;
    const clientIds = ids.map((r) => r.client_id).join(',');
    await sql`DELETE FROM auth_events WHERE meta->>'clientId' = ANY(string_to_array(${clientIds}, ','))`;
    await sql`DELETE FROM service_accounts WHERE name LIKE ${`ключ-тест-${RUN}-%`}`;
  }

  beforeEach(async () => {
    currentUser = as(adminId, 'admin');
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await clean();
    await sql`DELETE FROM users WHERE id IN (${adminId}, ${managerId})`;
    await sql.end({ timeout: 5 });
  });

  // ─── HTTP ───
  async function create(name: string, body: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/api-keys',
      payload: { name: NAME(name), allowAck: false, ...body },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { key: KeyDto; clientSecret: string };
  }
  const patch = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/admin/api-keys/${id}`, payload: body });
  const rotate = (id: string, expectedGeneration: number) =>
    app.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${id}/rotate-secret`, payload: { expectedGeneration } });
  const revoke = (id: string) => app.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${id}/revoke` });
  async function list(): Promise<KeyDto[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/api-keys' });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  // ─── Машинная сторона ───
  async function token(clientId: string, clientSecret: string) {
    return issueMachineToken(db, { clientId, clientSecret, ip: IP, userAgent: 'test' });
  }
  async function tokenOk(clientId: string, clientSecret: string): Promise<string> {
    const r = await token(clientId, clientSecret);
    expect(r.ok).toBe(true);
    return (r as { accessToken: string }).accessToken;
  }
  const principal = (t: string) => resolveServicePrincipal(db, t, IP);
  const row = async (id: string) =>
    (await sql<{ secret_generation: number; revoked_at: string | null; last_used_at: string | null; allowed_cidrs: string[] | null }[]>`
      SELECT secret_generation, revoked_at::text, last_used_at::text, allowed_cidrs FROM service_accounts WHERE id = ${id}`)[0]!;
  const events = async (clientId: string, event: string) =>
    (await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM auth_events WHERE event = ${event} AND meta->>'clientId' = ${clientId}`)[0]!.n;

  it('создание: секрет только в ответе, ключ работает, в списке нет ни секрета, ни хеша', async () => {
    const { key, clientSecret } = await create('создание', { description: 'для 1С бухгалтерии' });
    expect(clientSecret).toMatch(/^mcs_/);
    expect(key.clientId).toMatch(/^api-[0-9a-f]{12}$/);
    expect(key).toMatchObject({ status: 'active', allowAck: false, createdByName: 'Админ Ключей' });
    const t = await tokenOk(key.clientId, clientSecret);
    expect((await principal(t))?.scopes).toEqual([SCOPE_ONEC_READ]);

    const raw = JSON.stringify(await list());
    const [{ secret_hash }] = await sql<{ secret_hash: string }[]>`
      SELECT secret_hash FROM service_accounts WHERE id = ${key.id}`;
    expect(raw).not.toContain(clientSecret);
    expect(raw).not.toContain(secret_hash);
    expect(await events(key.clientId, 'service_account_created')).toBe('1');
    const [ev] = await sql<{ user_id: string }[]>`
      SELECT user_id FROM auth_events WHERE event = 'service_account_created' AND meta->>'clientId' = ${key.clientId}`;
    expect(ev!.user_id).toBe(adminId);
  });

  it('снятие «подтверждения загрузки» действует на уже выданный токен сразу', async () => {
    const { key, clientSecret } = await create('снятие', { allowAck: true });
    const t = await tokenOk(key.clientId, clientSecret);
    expect((await principal(t))?.scopes).toContain(SCOPE_ONEC_ACK);
    expect((await patch(key.id, { allowAck: false })).statusCode).toBe(200);
    expect((await principal(t))?.scopes).toEqual([SCOPE_ONEC_READ]);
  });

  it('добавление права действует только с нового токена', async () => {
    const { key, clientSecret } = await create('добавление', { allowAck: false });
    const old = await tokenOk(key.clientId, clientSecret);
    const res = await patch(key.id, { allowAck: true });
    expect(res.json().allowAck).toBe(true);
    expect((await principal(old))?.scopes).toEqual([SCOPE_ONEC_READ]);
    const fresh = await tokenOk(key.clientId, clientSecret);
    expect((await principal(fresh))?.scopes).toEqual([SCOPE_ONEC_READ, SCOPE_ONEC_ACK]);
    expect(await events(key.clientId, 'service_account_updated')).toBe('1');
  });

  it('новый секрет: старый секрет и старый токен перестают работать; устаревшее поколение — 409', async () => {
    const { key, clientSecret } = await create('ротация');
    const old = await tokenOk(key.clientId, clientSecret);
    const res = await rotate(key.id, key.secretGeneration);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { key: KeyDto; clientSecret: string };
    expect(body.key.secretGeneration).toBe(key.secretGeneration + 1);
    expect(await principal(old)).toBeNull();
    expect((await token(key.clientId, clientSecret)).ok).toBe(false);
    await tokenOk(key.clientId, body.clientSecret);
    const stale = await rotate(key.id, key.secretGeneration);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('generation_changed');
    expect(await events(key.clientId, 'service_account_secret_rotated')).toBe('1');
  });

  it('две ротации одновременно: ровно одна проходит, рабочий только её секрет', async () => {
    const { key } = await create('две-ротации');
    const [a, b] = await Promise.all([rotate(key.id, key.secretGeneration), rotate(key.id, key.secretGeneration)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = (a.statusCode === 200 ? a : b).json() as { clientSecret: string };
    const loser = a.statusCode === 200 ? b : a;
    expect(loser.json().error).toBe('generation_changed');
    expect((await row(key.id)).secret_generation).toBe(key.secretGeneration + 1);
    await tokenOk(key.clientId, winner.clientSecret);
  });

  it('ротация и отзыв: в любом порядке и одновременно итог — «отозван»', async () => {
    const first = await create('отзыв-затем-ротация');
    expect((await revoke(first.key.id)).statusCode).toBe(200);
    const r = await rotate(first.key.id, first.key.secretGeneration);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('revoked');

    const second = await create('ротация-затем-отзыв');
    const rotated = (await rotate(second.key.id, second.key.secretGeneration)).json() as { clientSecret: string };
    await revoke(second.key.id);
    expect((await token(second.key.clientId, second.clientSecret)).ok).toBe(false);
    expect((await token(second.key.clientId, rotated.clientSecret)).ok).toBe(false);

    const third = await create('одновременно');
    const [rot, rev] = await Promise.all([rotate(third.key.id, third.key.secretGeneration), revoke(third.key.id)]);
    expect(rev.statusCode).toBe(200);
    expect([200, 409]).toContain(rot.statusCode);
    expect((await row(third.key.id)).revoked_at).not.toBeNull();
    if (rot.statusCode === 200) {
      expect((await token(third.key.clientId, rot.json().clientSecret)).ok).toBe(false);
    }
  });

  it('отзыв: токен и выдача перестают работать, правка — 409; повтор не сдвигает revoked_at и не пишет второе событие', async () => {
    const { key, clientSecret } = await create('отзыв');
    const t = await tokenOk(key.clientId, clientSecret);
    const res = await revoke(key.id);
    expect(res.json().status).toBe('revoked');
    expect(await principal(t)).toBeNull();
    expect((await token(key.clientId, clientSecret)).ok).toBe(false);
    const p = await patch(key.id, { name: NAME('новое-имя') });
    expect(p.statusCode).toBe(409);
    expect(p.json().error).toBe('revoked');
    const before = (await row(key.id)).revoked_at;
    expect((await revoke(key.id)).statusCode).toBe(200);
    expect((await row(key.id)).revoked_at).toBe(before);
    expect(await events(key.clientId, 'service_account_revoked')).toBe('1');
  });

  it('срок: истёкший ключ не выдаёт токен и не пускает с уже выданным; продление возвращает работу', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { key, clientSecret } = await create('срок', { expiresAt: future });
    const t = await tokenOk(key.clientId, clientSecret);
    await sql`UPDATE service_accounts SET expires_at = now() - interval '1 minute' WHERE id = ${key.id}`;
    expect(await principal(t)).toBeNull();
    const denied = await token(key.clientId, clientSecret);
    expect(denied).toEqual({ ok: false, reason: 'expired' });
    expect((await list()).find((k) => k.id === key.id)?.status).toBe('expired');
    expect((await patch(key.id, { expiresAt: future })).statusCode).toBe(200);
    expect(await principal(t)).not.toBeNull();
    expect((await patch(key.id, { expiresAt: null })).json().expiresAt).toBeNull();
  });

  it('сети, заданные командой, переживают правку со страницы', async () => {
    const { key } = await create('сети');
    await sql`UPDATE service_accounts SET allowed_cidrs = string_to_array('10.0.0.0/8', ',') WHERE id = ${key.id}`;
    const res = await patch(key.id, { name: NAME('сети-2'), allowAck: true, description: 'другое' });
    expect(res.json().allowedCidrs).toEqual(['10.0.0.0/8']);
    expect((await row(key.id)).allowed_cidrs).toEqual(['10.0.0.0/8']);
  });

  it('последний запрос пишется не чаще раза в минуту', async () => {
    const { key, clientSecret } = await create('последний-запрос');
    const t = await tokenOk(key.clientId, clientSecret);
    const waitFor = async (pred: (v: string | null) => boolean) => {
      for (let i = 0; i < 50; i++) {
        const v = (await row(key.id)).last_used_at;
        if (pred(v)) return v;
        await new Promise((r) => setTimeout(r, 20));
      }
      return (await row(key.id)).last_used_at;
    };
    await principal(t);
    const first = await waitFor((v) => v !== null);
    expect(first).not.toBeNull();
    await principal(t);
    await new Promise((r) => setTimeout(r, 100));
    expect((await row(key.id)).last_used_at).toBe(first);
    await sql`UPDATE service_accounts SET last_used_at = now() - interval '2 minutes' WHERE id = ${key.id}`;
    const aged = (await row(key.id)).last_used_at;
    await principal(t);
    const second = await waitFor((v) => v !== aged);
    expect(second).not.toBe(aged);
    expect((await list()).find((k) => k.id === key.id)?.lastUsedAt).not.toBeNull();
  });

  it('журнал атомарен с изменением: сбой записи журнала откатывает создание и ротацию', async () => {
    const constraint = `api_keys_test_block_${RUN}`;
    try {
      await sql.unsafe(`ALTER TABLE auth_events ADD CONSTRAINT ${constraint}
        CHECK (event NOT IN ('service_account_created', 'service_account_secret_rotated')) NOT VALID`);
      const failed = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/api-keys',
        payload: { name: NAME('атомарность'), allowAck: false },
      });
      expect(failed.statusCode).toBe(500);
      expect(JSON.stringify(failed.json())).not.toContain('mcs_');
      const [{ n }] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM service_accounts WHERE name = ${NAME('атомарность')}`;
      expect(n).toBe('0');
    } finally {
      await sql.unsafe(`ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS ${constraint}`);
    }

    const { key, clientSecret } = await create('атомарность-ротация');
    try {
      await sql.unsafe(`ALTER TABLE auth_events ADD CONSTRAINT ${constraint}
        CHECK (event <> 'service_account_secret_rotated') NOT VALID`);
      const res = await rotate(key.id, key.secretGeneration);
      expect(res.statusCode).toBe(500);
      expect((await row(key.id)).secret_generation).toBe(key.secretGeneration);
      await tokenOk(key.clientId, clientSecret);
    } finally {
      await sql.unsafe(`ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
  });

  it('не-администратор получает 403 на всех маршрутах', async () => {
    const { key } = await create('чужой');
    currentUser = as(managerId, 'manager');
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/admin/api-keys' }),
      app.inject({ method: 'POST', url: '/api/v1/admin/api-keys', payload: { name: NAME('нет'), allowAck: true } }),
      patch(key.id, { name: NAME('нет') }),
      rotate(key.id, key.secretGeneration),
      revoke(key.id),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    currentUser = as(adminId, 'admin');
    expect((await list()).find((k) => k.id === key.id)?.status).toBe('active');
  });
});
