/**
 * Админские операции с почтовыми ящиками: заведение ящика для документов,
 * включение автоопроса и кнопка «Проверить сейчас».
 *
 * Ключевое поведение: проверка доступов должна работать ДО включения
 * постоянного опроса, а запрос не должен ждать самого опроса — он идёт в
 * отдельном процессе.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailAccountRoutes } from '../../src/routes/admin/mail-accounts.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.admin-test.local';

suite('админка почтовых ящиков (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let queueAdd: ReturnType<typeof vi.fn>;
  let currentUser: AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    queueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('queues', { mailPoll: { add: queueAdd } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(mailAccountRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    queueAdd.mockClear();
    currentUser = { id: '00000000-0000-0000-0000-000000000001', role: 'admin' } as AuthUser;
  });

  const createAccount = (purpose: 'request' | 'document') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/admin/mail-accounts',
      payload: {
        name: `ящик-${purpose}`,
        host: HOST,
        port: 993,
        useTls: true,
        username: 'upd@company.ru',
        password: 'app-password',
        folder: 'INBOX',
        isActive: true,
        purpose,
        pollEnabled: false,
      },
    });

  it('ящик для документов заводится с выключенным автоопросом', async () => {
    const res = await createAccount('document');
    expect(res.statusCode).toBe(201);
    // Автоопрос не включается заведением ящика: сначала проверяют доступы.
    expect(res.json()).toMatchObject({ purpose: 'document', pollEnabled: false });
  });

  it('«Проверить сейчас» ставит задачу в очередь и сразу отвечает', async () => {
    const created = await createAccount('document');
    const id = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/mail-accounts/${id}/poll`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: true, jobId: 'job-1' });
    expect(queueAdd).toHaveBeenCalledWith('poll', { accountId: id });
  });

  it('проверка работает при выключенном автоопросе — ради неё она и нужна', async () => {
    const created = await createAccount('document');
    expect(created.json().pollEnabled).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/mail-accounts/${created.json().id}/poll`,
    });
    expect(res.statusCode).toBe(202);
  });

  it('для ящика заявок кнопка недоступна: у него свой путь', async () => {
    const created = await createAccount('request');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/mail-accounts/${created.json().id}/poll`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'wrong_purpose' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('отключённый ящик не опрашивается', async () => {
    const created = await createAccount('document');
    const id = created.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/mail-accounts/${id}`,
      payload: { isActive: false },
    });

    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/mail-accounts/${id}/poll` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'inactive' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('несуществующий ящик → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/mail-accounts/00000000-0000-0000-0000-0000000000ff/poll',
    });
    expect(res.statusCode).toBe(404);
  });

  it('автоопрос включается и выключается без пересоздания ящика', async () => {
    const created = await createAccount('document');
    const id = created.json().id;

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/mail-accounts/${id}`,
      payload: { pollEnabled: true },
    });
    expect(on.json()).toMatchObject({ pollEnabled: true });

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/mail-accounts/${id}`,
      payload: { pollEnabled: false },
    });
    expect(off.json()).toMatchObject({ pollEnabled: false });
  });

  it('правка без пароля не затирает сохранённый пароль', async () => {
    const created = await createAccount('document');
    const id = created.json().id;
    const [before] = await sql<{ password_encrypted: string }[]>`
      SELECT password_encrypted FROM mail_accounts WHERE id = ${id}`;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/mail-accounts/${id}`,
      payload: { name: 'переименован' },
    });

    const [after] = await sql<{ password_encrypted: string }[]>`
      SELECT password_encrypted FROM mail_accounts WHERE id = ${id}`;
    expect(after!.password_encrypted).toBe(before!.password_encrypted);
  });

  it('менеджеру админка ящиков недоступна', async () => {
    currentUser = { id: '00000000-0000-0000-0000-000000000002', role: 'manager' } as AuthUser;
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/mail-accounts' });
    expect(res.statusCode).toBe(403);
  });
});
