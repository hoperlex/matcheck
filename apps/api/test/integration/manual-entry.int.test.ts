/**
 * «Ручной внос» / «Ручной вынос» — флаг is_manual (миграция 0153).
 *
 * Свойства, ради которых флаг заводился (жалоба 16.11, приёмка 25454):
 *  - запрос планшетной формы «Ручной внос» (маркер первой строкой, сразу
 *    confirmed_mol, без номера и документов) получает is_manual = true;
 *  - обычная приёмка, оба этапа которой прошли офлайн (тоже сразу
 *    confirmed_mol), остаётся false — статус сам по себе не признак;
 *  - флаг ставится только при создании: правка комментария, явный false и
 *    любой upsert его не меняют;
 *  - явный isManual портала у недопустимой записи — 400, у планшета без поля —
 *    просто false (4xx заблокировал бы очередь мутаций планшета);
 *  - ручной вынос нельзя перевести в перемещение — 422;
 *  - флаг виден в ответе, GET /:id и /sync; фильтр entry одинаково сужает
 *    список и выгрузку.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import { syncRoutes } from '../../src/routes/sync.js';
import { deliveries, sessions, shipments, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('ручной внос / вынос — is_manual (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const inspectorId = randomUUID();
  const managerId = randomUUID();
  const inspectorSession = randomUUID();
  const managerSession = randomUUID();
  const counterpartyId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: { deliveries, shipments, sites, statuses, users, sessions },
    });

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
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    app.decorate('logUnauthorized', async () => {});
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.register(syncRoutes);
    await app.ready();

    const code = `MN${siteId.slice(0, 6)}`;
    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteId}, ${code}, 'Ручной внос'),
      (${otherSiteId}, ${`${code}B`}, 'Ручной внос — соседний')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorId}, ${`mn-i-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId}),
      (${managerId}, ${`mn-m-${managerId}@test`}, 'x', 'manager', NULL)`;
    // FK created_by_session_id: строки сессий обязательны.
    await sql`INSERT INTO sessions (id, user_id) VALUES
      (${inspectorSession}, ${inspectorId}), (${managerSession}, ${managerId})`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
      VALUES (${counterpartyId}, ${`7${counterpartyId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, 'Подрядчик вноса', true)`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM shipments WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM counterparties WHERE id = ${counterpartyId}`;
    await sql`DELETE FROM sessions WHERE user_id IN (${inspectorId}, ${managerId})`;
    await sql`DELETE FROM users WHERE id IN (${inspectorId}, ${managerId})`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${otherSiteId})`;
    await sql.end({ timeout: 5 });
  });

  const asInspector = (): AuthUser => ({
    id: inspectorId,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId: inspectorSession,
  });
  const asManager = (): AuthUser => ({
    id: managerId,
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: managerSession,
  });

  const post = (url: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, payload: body });

  /** Тело планшетной формы «Ручной внос» (ManualEntryFormViewModel.kt). */
  const tabletManualDelivery = (id: string, at = '2026-11-16T08:00:00.000Z') => ({
    id,
    statusCode: 'confirmed_mol',
    siteId,
    supplierId: null,
    contractorId: null,
    recipientMolId: null,
    vehiclePlate: null,
    arrivedAt: at,
    confirmedByMolAt: at,
    comment: 'Ручной внос\nКомментарий: "принесли руками"',
    inTransit: false,
    isAssets: false,
    sourceDocumentIds: [],
    items: [],
  });

  /** Тело планшетной формы «Ручной вынос» (ManualDispatchFormViewModel.kt). */
  const tabletManualShipment = (id: string, at = '2026-11-16T09:00:00.000Z') => ({
    id,
    statusCode: 'confirmed_mol',
    kind: 'contractor',
    siteId,
    receiverCounterpartyId: null,
    receiverMolId: null,
    vehiclePlate: null,
    shippedAt: at,
    confirmedByMolAt: at,
    comment: 'Ручной вынос',
    inTransit: false,
    isAssets: false,
    sourceDocumentIds: [],
    items: [],
  });

  const isManualOf = async (table: 'deliveries' | 'shipments', id: string) => {
    const rows =
      table === 'deliveries'
        ? await sql<{ is_manual: boolean }[]>`SELECT is_manual FROM deliveries WHERE id = ${id}`
        : await sql<{ is_manual: boolean }[]>`SELECT is_manual FROM shipments WHERE id = ${id}`;
    return rows[0]!.is_manual;
  };

  it('планшетный ручной внос → is_manual = true в БД, ответе, GET /:id и /sync', async () => {
    currentUser = asInspector();
    const id = randomUUID();

    const res = await post('/api/v1/deliveries', tabletManualDelivery(id));

    expect(res.statusCode).toBe(200);
    expect(res.json().isManual).toBe(true);
    expect(await isManualOf('deliveries', id)).toBe(true);

    const one = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().isManual).toBe(true);

    const sync = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });
    expect(sync.statusCode).toBe(200);
    const fromSync = (sync.json().deliveries as { id: string; isManual?: boolean }[]).find(
      (d) => d.id === id,
    );
    expect(fromSync?.isManual).toBe(true);
  });

  it('офлайн-обычная приёмка (сразу confirmed_mol, с номером) остаётся с машиной', async () => {
    currentUser = asInspector();
    const id = randomUUID();

    const res = await post('/api/v1/deliveries', {
      ...tabletManualDelivery(id),
      vehiclePlate: 'А123ВС77',
      comment: '1 Этап: "всё ок"\n2 Этап: "принято"',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().isManual).toBe(false);
  });

  it('маркер планшета, но с номером → false без отказа (очередь планшета не встаёт)', async () => {
    currentUser = asInspector();
    const id = randomUUID();

    const res = await post('/api/v1/deliveries', {
      ...tabletManualDelivery(id),
      vehiclePlate: 'БН',
    });

    expect(res.statusCode).toBe(200);
    expect(await isManualOf('deliveries', id)).toBe(false);
  });

  it('флаг не меняется: правка комментария, явный false, upsert портала', async () => {
    currentUser = asInspector();
    const id = randomUUID();
    expect((await post('/api/v1/deliveries', tabletManualDelivery(id))).statusCode).toBe(200);

    currentUser = asManager();
    const res = await post('/api/v1/deliveries', {
      ...tabletManualDelivery(id),
      comment: 'переписали комментарий',
      vehiclePlate: 'БН',
      isManual: false,
      baseVersion: 1,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().isManual).toBe(true);
    expect(await isManualOf('deliveries', id)).toBe(true);
  });

  it('явный isManual: true у существующей обычной приёмки игнорируется', async () => {
    currentUser = asInspector();
    const id = randomUUID();
    expect(
      (
        await post('/api/v1/deliveries', {
          id,
          statusCode: 'filled',
          siteId,
          vehiclePlate: 'К777КК77',
          items: [],
          sourceDocumentIds: [],
        })
      ).statusCode,
    ).toBe(200);

    currentUser = asManager();
    const res = await post('/api/v1/deliveries', {
      id,
      statusCode: 'filled',
      siteId,
      vehiclePlate: 'К777КК77',
      isManual: true,
      items: [],
      sourceDocumentIds: [],
      baseVersion: 1,
    });

    expect(res.statusCode).toBe(200);
    expect(await isManualOf('deliveries', id)).toBe(false);
  });

  it('портал: явный ручной внос создаётся сразу подтверждённым, время — присланное', async () => {
    currentUser = asManager();
    const id = randomUUID();
    const at = '2026-11-15T18:30:00.000Z';

    const res = await post('/api/v1/deliveries', {
      id,
      statusCode: 'confirmed_mol',
      siteId,
      vehiclePlate: null,
      arrivedAt: at,
      confirmedByMolAt: at,
      comment: 'с портала',
      isManual: true,
      items: [],
      sourceDocumentIds: [],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isManual).toBe(true);
    expect(body.status.code).toBe('confirmed_mol');
    expect(body.confirmedByMolUserId).toBe(managerId);
    // Офлайн-отправка утром не сдвигает подтверждение на время запроса.
    expect(new Date(body.confirmedByMolAt).toISOString()).toBe(at);
  });

  it.each([
    ['с госномером', { vehiclePlate: 'А001АА77' }],
    ['не сразу подтверждённый', { statusCode: 'filled' }],
    ['транзит', { inTransit: true }],
  ])('портал: явный ручной внос %s → 400 invalid_manual_entry', async (_name, patch) => {
    currentUser = asManager();
    const id = randomUUID();

    const res = await post('/api/v1/deliveries', {
      id,
      statusCode: 'confirmed_mol',
      siteId,
      vehiclePlate: null,
      arrivedAt: '2026-11-16T08:00:00.000Z',
      isManual: true,
      items: [],
      sourceDocumentIds: [],
      ...patch,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_manual_entry');
    const [row] = await sql`SELECT 1 FROM deliveries WHERE id = ${id}`;
    expect(row).toBeUndefined();
  });

  it('планшетный ручной вынос → true; перевод в перемещение → 422', async () => {
    currentUser = asInspector();
    const id = randomUUID();

    const res = await post('/api/v1/shipments', tabletManualShipment(id));
    expect(res.statusCode).toBe(200);
    expect(res.json().isManual).toBe(true);

    currentUser = asManager();
    const toTransfer = await post('/api/v1/shipments', {
      ...tabletManualShipment(id),
      kind: 'transfer',
      destSiteId: otherSiteId,
      receiverCounterpartyId: counterpartyId,
      baseVersion: 1,
    });

    expect(toTransfer.statusCode).toBe(422);
    expect(toTransfer.json().error).toBe('manual_transfer_forbidden');
    const [row] = await sql<{ kind: string; version: number }[]>`
      SELECT kind, version FROM shipments WHERE id = ${id}`;
    expect(row).toEqual({ kind: 'contractor', version: 1 });
    // Парная приёмка не заведена.
    const paired = await sql`SELECT 1 FROM deliveries WHERE source_shipment_id = ${id}`;
    expect(paired).toHaveLength(0);
  });

  it('портал: явный ручной вынос перемещением → 400, обычное перемещение → false', async () => {
    currentUser = asManager();
    const bad = await post('/api/v1/shipments', {
      ...tabletManualShipment(randomUUID()),
      comment: null,
      kind: 'transfer',
      destSiteId: otherSiteId,
      receiverCounterpartyId: counterpartyId,
      isManual: true,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_manual_entry');

    const id = randomUUID();
    const ok = await post('/api/v1/shipments', {
      ...tabletManualShipment(id),
      kind: 'transfer',
      destSiteId: otherSiteId,
      receiverCounterpartyId: counterpartyId,
    });
    expect(ok.statusCode).toBe(200);
    // Маркер есть, но перемещение ручным быть не может.
    expect(await isManualOf('shipments', id)).toBe(false);
    // Парная приёмка перемещения — обычная.
    const [pair] = await sql<{ is_manual: boolean }[]>`
      SELECT is_manual FROM deliveries WHERE source_shipment_id = ${id}`;
    expect(pair?.is_manual).toBe(false);
  });

  /** Короткие id строк верхнего уровня выгрузки (колонка «id»). */
  async function exportDisplayIds(url: string): Promise<number[]> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const ids: number[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.outlineLevel === 1) return;
      const value = row.getCell(2).value;
      if (typeof value === 'number') ids.push(value);
    });
    return ids.sort((a, b) => a - b);
  }

  async function listDisplayIds(url: string): Promise<number[]> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return (res.json().items as { displayId: number }[])
      .map((d) => d.displayId)
      .sort((a, b) => a - b);
  }

  it('фильтр entry: список и выгрузка совпадают, вместе дают всё; мусор → 400', async () => {
    currentUser = asManager();
    const base = `siteIds=${siteId}&limit=200`;

    const all = await listDisplayIds(`/api/v1/deliveries?${base}`);
    const manual = await listDisplayIds(`/api/v1/deliveries?${base}&entry=manual`);
    const vehicle = await listDisplayIds(`/api/v1/deliveries?${base}&entry=vehicle`);
    expect(manual.length).toBeGreaterThan(0);
    expect(vehicle.length).toBeGreaterThan(0);
    expect([...manual, ...vehicle].sort((a, b) => a - b)).toEqual(all);
    expect(
      await exportDisplayIds(`/api/v1/deliveries/export.xlsx?siteIds=${siteId}&entry=manual`),
    ).toEqual(manual);

    const shManual = await listDisplayIds(`/api/v1/shipments?${base}&entry=manual`);
    expect(shManual.length).toBeGreaterThan(0);
    expect(
      await exportDisplayIds(`/api/v1/shipments/export.xlsx?siteIds=${siteId}&entry=manual`),
    ).toEqual(shManual);

    const bad = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${base}&entry=yes` });
    expect(bad.statusCode).toBe(400);
  });
});
