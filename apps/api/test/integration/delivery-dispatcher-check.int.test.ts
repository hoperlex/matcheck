/**
 * Отметка «Диспетчер» у приёмки на реальном PostgreSQL.
 *
 * Права и гейт зрелости — как у «Проверено» (действие review), но отметка
 * снимается. Она не двигает version/updated_at: планшетам она не нужна, и
 * лишний повтор синхронизации им ни к чему. Видят её — и фильтруют по ней —
 * только роли с отметкой проверки; список и выгрузка отбирают одно и то же.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { deliveries, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('отметка «Диспетчер» (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  const RUN = String(Date.now()).slice(-6);
  const siteId = randomUUID();
  const managerId = randomUUID();
  const inspectorId = randomUUID();
  const checked = randomUUID();
  const unchecked = randomUUID();
  const notFilled = randomUUID();
  const pending = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, sites, statuses, users } });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`DC${RUN.slice(-4)}`}, 'Диспетчер')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${managerId}, ${`disp-${managerId}@test`}, 'x', 'manager', NULL),
      (${inspectorId}, ${`disp-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;
    const status = async (code: string) =>
      (
        await sql<{ id: string }[]>`
          SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = ${code} LIMIT 1`
      )[0]!.id;
    const filled = await status('filled');
    const draft = await status('not_filled');
    await sql`INSERT INTO deliveries (id, site_id, status_id, version) VALUES
      (${checked}, ${siteId}, ${filled}, 1),
      (${unchecked}, ${siteId}, ${filled}, 1),
      (${notFilled}, ${siteId}, ${draft}, 1)`;
    await sql`INSERT INTO deliveries (id, site_id, status_id, version, pending_deletion_at, pending_deletion_by_user_id)
      VALUES (${pending}, ${siteId}, ${filled}, 1, now(), ${managerId})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id IN (${managerId}, ${inspectorId})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const as = (role: UserRole, id = randomUUID(), site: string | null = null): AuthUser => ({
    id,
    role,
    siteId: site,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });
  const mark = (id: string, value: boolean) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/deliveries/${id}/dispatcher-check`,
      payload: { checked: value },
    });
  async function row(id: string) {
    const [r] = await sql<
      {
        dispatcher_checked_at: unknown;
        dispatcher_checked_by_user_id: string | null;
        version: number;
        updated_at: unknown;
      }[]
    >`SELECT dispatcher_checked_at, dispatcher_checked_by_user_id, version, updated_at
      FROM deliveries WHERE id = ${id}`;
    return r!;
  }

  it('ставится и снимается; version и updated_at не двигаются', async () => {
    currentUser = as('manager', managerId);
    const before = await row(checked);

    const res = await mark(checked, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      dispatcherCheckedByUserEmail: `disp-${managerId}@test`,
    });
    expect(res.json().dispatcherCheckedAt).toBeTruthy();
    const after = await row(checked);
    expect(after.dispatcher_checked_by_user_id).toBe(managerId);
    expect(after.version).toBe(before.version);
    expect(String(after.updated_at)).toBe(String(before.updated_at));

    const off = await mark(checked, false);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ dispatcherCheckedAt: null, dispatcherCheckedByUserEmail: null });
    expect((await row(checked)).dispatcher_checked_at).toBeNull();

    expect((await mark(checked, true)).statusCode).toBe(200);
  });

  it('мониторинг и админ тоже; инспектор и подрядчик — 403', async () => {
    for (const role of ['monitor', 'admin'] as const) {
      currentUser = as(role);
      expect((await mark(unchecked, false)).statusCode).toBe(200);
    }
    for (const role of ['inspector_kpp', 'contractor', 'observer'] as const) {
      currentUser = as(role);
      expect((await mark(unchecked, true)).statusCode).toBe(403);
    }
    expect((await row(unchecked)).dispatcher_checked_at).toBeNull();
  });

  it('неоформленная — 422, помеченная на удаление — 409, чужой id — 404', async () => {
    currentUser = as('manager', managerId);
    expect((await mark(notFilled, true)).statusCode).toBe(422);
    expect((await mark(pending, true)).statusCode).toBe(409);
    expect((await mark(randomUUID(), true)).statusCode).toBe(404);
    expect((await row(notFilled)).dispatcher_checked_at).toBeNull();
    expect((await row(pending)).dispatcher_checked_at).toBeNull();
  });

  async function listIds(params: Record<string, string>): Promise<string[]> {
    const qs = new URLSearchParams({ siteIds: siteId, limit: '200', ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${qs}` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string }[] }).items.map((i) => i.id).sort();
  }
  async function exportCount(params: Record<string, string>): Promise<number> {
    const qs = new URLSearchParams({ siteIds: siteId, ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/export.xlsx?${qs}` });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    let n = 0;
    wb.worksheets[0]!.eachRow((r, i) => {
      if (i > 1 && r.outlineLevel !== 1) n++;
    });
    return n;
  }

  it('фильтр «отмечено / не отмечено»; выгрузка отбирает то же и пишет колонку', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({ dispatcherCheck: 'checked' })).toEqual([checked]);
    expect(await listIds({ dispatcherCheck: 'none' })).toEqual([notFilled, unchecked].sort());
    expect(await exportCount({ dispatcherCheck: 'checked' })).toBe(1);
    expect(await exportCount({ dispatcherCheck: 'none' })).toBe(2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/export.xlsx?${new URLSearchParams({ siteIds: siteId, dispatcherCheck: 'checked' })}`,
    });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
    const col = header.indexOf('Диспетчер');
    expect(col).toBeGreaterThan(header.indexOf('Требует проверки'));
    expect(String(ws.getRow(2).getCell(col).value)).toContain(`disp-${managerId}@test`);
  });

  it('инспектору поля пустые, а фильтр не действует', async () => {
    currentUser = as('inspector_kpp', inspectorId, siteId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${checked}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dispatcherCheckedAt: null, dispatcherCheckedByUserEmail: null });
    // Без права параметр игнорируется — список не сужается молча.
    expect(await listIds({ dispatcherCheck: 'checked' })).toEqual(
      [checked, notFilled, unchecked].sort(),
    );
  });
});
