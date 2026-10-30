import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import type { Row } from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('получатели документов приёмки (PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  let reviewAllowed = true;
  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const contractorId = randomUUID();
  const molId = randomUUID();
  const docs = [randomUUID(), randomUUID()];
  let filledStatusId: string;
  const deliveryIds: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 5 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (n: number) => { send: (v: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role))
            reply.code(403).send({ error: 'forbidden' });
        },
    );
    app.decorate('permissions', {
      enforced: true,
      get: async () =>
        new Map(reviewAllowed ? [] : [['manager:operations.deliveries', { review: false }]]),
    } as never);
    app.decorate('logUnauthorized', async () => {});
    await app.register(deliveryRoutes);
    await app.ready();
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`DR${siteId.slice(0, 6)}`}, 'Разные получатели')`;
    await sql`INSERT INTO users (id, email, password_hash, role) VALUES (${managerId}, ${`dr-${managerId}@test`}, 'x', 'manager')`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
      VALUES (${contractorId}, ${`8${contractorId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, 'Подрядчик документа', true)`;
    await sql`INSERT INTO responsible_persons (id, full_name) VALUES (${molId}, 'МОЛ документа')`;
    const [status] = await sql<
      { id: string }[]
    >`SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`;
    filledStatusId = status!.id;
    for (const [index, id] of docs.entries()) {
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${`DR-${index}`}, now(), '100.00', now())`;
    }
  });

  beforeEach(() => {
    reviewAllowed = true;
    currentUser = { ...currentUser, role: 'manager' };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE id IN ${sql(deliveryIds)}`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql(docs)}`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM responsible_persons WHERE id = ${molId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function makeDelivery(linkCount = 2, recipient: 'contractor' | 'mol' | 'none' = 'none') {
    const id = randomUUID();
    deliveryIds.push(id);
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, recipient_mol_id, purpose)
      VALUES (${id}, ${siteId}, ${filledStatusId},
        ${recipient === 'contractor' ? contractorId : null}, ${recipient === 'mol' ? molId : null},
        ${recipient === 'mol' ? 'own_forces' : null})`;
    for (const docId of docs.slice(0, linkCount)) {
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docId})`;
    }
    return id;
  }
  const patch = (id: string, suffix: string, payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/deliveries/${id}${suffix}`,
      payload,
    });
  const link = (docId: string) => `/sources/${docId}`;

  it('режим требует две связи; при одном оставшемся выключается и сбрасывает значения', async () => {
    const id = await makeDelivery(1);
    expect((await patch(id, '/recipient-mode', { perDocument: true })).statusCode).toBe(422);
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docs[1]})`;
    expect((await patch(id, '/recipient-mode', { perDocument: true })).statusCode).toBe(200);
    expect(
      (await patch(id, `${link(docs[0]!)}/recipient`, { recipientMolId: molId })).json(),
    ).toMatchObject({
      recipientsPerDocument: true,
      documentRecipients: [{ ownRecipient: true, ownPurpose: true, purpose: 'own_forces' }],
    });
    await sql`DELETE FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docs[1]}`;
    expect((await patch(id, '/recipient-mode', { perDocument: false })).statusCode).toBe(200);
    const [row] = await sql<{ own_recipient: boolean; own_purpose: boolean }[]>`
      SELECT own_recipient, own_purpose FROM delivery_sources WHERE delivery_id=${id}`;
    expect(row).toMatchObject({ own_recipient: false, own_purpose: false });
  });

  it('поля независимы; смена МОЛ на подрядчика даёт собственный NULL и пустой признак в Excel', async () => {
    const id = await makeDelivery(2, 'mol');
    await patch(id, '/recipient-mode', { perDocument: true });
    const docId = docs[0]!;
    expect((await patch(id, `${link(docId)}/purpose`, { purpose: 'realization' })).statusCode).toBe(
      200,
    );
    const [onlyPurpose] = await sql<{ own_recipient: boolean; own_purpose: boolean }[]>`
      SELECT own_recipient, own_purpose FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docId}`;
    expect(onlyPurpose).toMatchObject({ own_recipient: false, own_purpose: true });
    await patch(id, `${link(docId)}/recipient`, { recipientMolId: molId });
    await patch(id, `${link(docId)}/purpose`, { purpose: 'own_forces' });
    const result = await patch(id, `${link(docId)}/recipient`, { contractorId });
    expect(result.statusCode).toBe(200);
    expect(result.json().documentRecipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDocumentId: docId,
          ownRecipient: true,
          ownPurpose: true,
          purpose: null,
        }),
      ]),
    );
    expect((await patch(id, `${link(docId)}/purpose`, { inherit: true })).statusCode).toBe(422);
    await sql`INSERT INTO delivery_items (delivery_id, source_document_id, name_raw, line_no)
      VALUES (${id}, ${docId}, 'Позиция с собственным NULL', 1)`;
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/export.xlsx?siteIds=${siteId}`,
    });
    expect(exportRes.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportRes.rawPayload as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const headings = (sheet.getRow(1).values as unknown[]).map(String);
    const nameColumn = headings.indexOf('Наименование');
    const purposeColumn = headings.indexOf('Признак');
    const recipientColumn = headings.indexOf('Получатель (по документу)');
    let itemRow: Row | undefined;
    sheet.eachRow((row) => {
      if (row.getCell(nameColumn).value === 'Позиция с собственным NULL') itemRow = row;
    });
    expect(purposeColumn).toBeGreaterThan(0);
    expect(recipientColumn).toBeGreaterThan(0);
    expect(itemRow?.getCell(purposeColumn).value ?? '').toBe('');
    expect(String(itemRow?.getCell(recipientColumn).value)).toContain('Подрядчик документа');
  });

  it('404/409, DTO одиночного и списка, отвязка и повторная привязка', async () => {
    const id = await makeDelivery();
    expect((await patch(id, `${link(docs[0]!)}/recipient`, { none: true })).statusCode).toBe(409);
    await patch(id, '/recipient-mode', { perDocument: true });
    expect((await patch(id, `${link(randomUUID())}/recipient`, { none: true })).statusCode).toBe(
      404,
    );
    await patch(id, `${link(docs[0]!)}/recipient`, { none: true });
    const single = (await app.inject({ method: 'GET', url: `/api/v1/deliveries/${id}` })).json();
    const list = (
      await app.inject({ method: 'GET', url: `/api/v1/deliveries?siteIds=${siteId}&limit=200` })
    ).json();
    expect(list.items.find((item: { id: string }) => item.id === id).documentRecipients).toEqual(
      single.documentRecipients,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${id}/unlink-source`,
          payload: { sourceDocumentId: docs[0] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${id}/link-source`,
          payload: { sourceDocumentId: docs[0] },
        })
      ).statusCode,
    ).toBe(200);
    const [relinked] = await sql<{ own_recipient: boolean; own_purpose: boolean }[]>`
      SELECT own_recipient, own_purpose FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docs[0]}`;
    expect(relinked).toMatchObject({ own_recipient: false, own_purpose: false });
  });

  it('выключение с собственным признаком требует review, вынужденный сброс — только edit', async () => {
    const id = await makeDelivery(2, 'mol');
    await patch(id, '/recipient-mode', { perDocument: true });
    await patch(id, `${link(docs[0]!)}/purpose`, { purpose: 'own_forces' });
    reviewAllowed = false;
    expect((await patch(id, '/recipient-mode', { perDocument: false })).statusCode).toBe(403);
    expect((await patch(id, `${link(docs[0]!)}/recipient`, { contractorId })).statusCode).toBe(200);
    reviewAllowed = true;
    expect((await patch(id, '/recipient-mode', { perDocument: false })).statusCode).toBe(200);
  });

  it('планшетный upsert без смены вида получателя не пишет связи; смена вида согласует признак', async () => {
    const id = await makeDelivery(2, 'mol');
    await patch(id, '/recipient-mode', { perDocument: true });
    const docId = docs[0]!;
    await patch(id, `${link(docId)}/purpose`, { purpose: 'own_forces' });
    const before = await sql<{ ctid: string }[]>`
      SELECT ctid::text AS ctid FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docId}`;
    const upsert = (recipient: { recipientMolId?: string; contractorId?: string }) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/deliveries',
        payload: {
          id,
          siteId,
          statusCode: 'filled',
          sourceDocumentIds: docs,
          items: [],
          ...recipient,
        },
      });
    expect((await upsert({ recipientMolId: molId })).statusCode).toBe(200);
    const unchanged = await sql<{ ctid: string }[]>`
      SELECT ctid::text AS ctid FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docId}`;
    expect(unchanged[0]!.ctid).toBe(before[0]!.ctid);
    expect((await upsert({ contractorId })).statusCode).toBe(200);
    const [after] = await sql<{ own_purpose: boolean; purpose: string | null }[]>`
      SELECT own_purpose, purpose FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docId}`;
    expect(after).toMatchObject({ own_purpose: true, purpose: null });
  });

  it('общий признак и общий получатель согласуют наследуемые значения документов', async () => {
    const id = await makeDelivery(2, 'mol');
    await patch(id, '/recipient-mode', { perDocument: true });
    const docId = docs[0]!;
    await patch(id, '/purpose', { purpose: 'realization' });
    await patch(id, `${link(docId)}/recipient`, { contractorId });
    expect((await patch(id, `${link(docId)}/purpose`, { inherit: true })).statusCode).toBe(200);
    expect((await patch(id, '/purpose', { purpose: 'own_forces' })).statusCode).toBe(200);
    const [ownContractor] = await sql<{ own_purpose: boolean; purpose: string | null }[]>`
      SELECT own_purpose, purpose FROM delivery_sources WHERE delivery_id=${id} AND source_document_id=${docId}`;
    expect(ownContractor).toMatchObject({ own_purpose: true, purpose: null });

    const another = await makeDelivery();
    await patch(another, '/recipient-mode', { perDocument: true });
    await patch(another, `${link(docId)}/purpose`, { purpose: 'realization' });
    const mobile = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: {
        id: another,
        siteId,
        statusCode: 'filled',
        sourceDocumentIds: docs,
        items: [],
        recipientMolId: molId,
      },
    });
    expect(mobile.statusCode).toBe(200);
    const [inheritedMol] = await sql<
      { own_recipient: boolean; own_purpose: boolean; purpose: string | null }[]
    >`
      SELECT own_recipient, own_purpose, purpose FROM delivery_sources WHERE delivery_id=${another} AND source_document_id=${docId}`;
    expect(inheritedMol).toMatchObject({
      own_recipient: false,
      own_purpose: true,
      purpose: 'own_forces',
    });
  });

  it('явный выбор и возврат общего признака закрыты без review', async () => {
    const id = await makeDelivery();
    await patch(id, '/recipient-mode', { perDocument: true });
    reviewAllowed = false;
    expect(
      (await patch(id, `${link(docs[0]!)}/purpose`, { purpose: 'realization' })).statusCode,
    ).toBe(403);
    expect((await patch(id, `${link(docs[0]!)}/purpose`, { inherit: true })).statusCode).toBe(403);
    const combined = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: {
        id,
        siteId,
        statusCode: 'filled',
        sourceDocumentIds: docs,
        items: [],
        contractorId,
        purpose: 'realization',
      },
    });
    expect(combined.statusCode).toBe(403);
    const [row] = await sql<{ contractor_id: string | null; purpose: string | null }[]>`
      SELECT contractor_id, purpose FROM deliveries WHERE id=${id}`;
    expect(row).toEqual({ contractor_id: null, purpose: null });
    reviewAllowed = true;
  });

  it('новые PATCH не двигают version/updated_at; монитор меняет только признак', async () => {
    const id = await makeDelivery();
    const before = await sql<{ version: number; updated_at: Date }[]>`
      SELECT version, updated_at FROM deliveries WHERE id=${id}`;
    expect((await patch(id, '/recipient-mode', { perDocument: true })).statusCode).toBe(200);
    expect((await patch(id, `${link(docs[0]!)}/recipient`, { none: true })).statusCode).toBe(200);
    currentUser = { ...currentUser, role: 'monitor' };
    expect(
      (await patch(id, `${link(docs[0]!)}/purpose`, { purpose: 'realization' })).statusCode,
    ).toBe(200);
    expect((await patch(id, `${link(docs[0]!)}/recipient`, { inherit: true })).statusCode).toBe(
      403,
    );
    expect((await patch(id, '/recipient-mode', { perDocument: false })).statusCode).toBe(403);
    const after = await sql<{ version: number; updated_at: Date }[]>`
      SELECT version, updated_at FROM deliveries WHERE id=${id}`;
    expect(after[0]!.version).toBe(before[0]!.version);
    expect(String(after[0]!.updated_at)).toBe(String(before[0]!.updated_at));
    currentUser = { ...currentUser, role: 'manager' };
  });

  it('помеченная на удаление приёмка запрещает правку документа', async () => {
    const id = await makeDelivery();
    await patch(id, '/recipient-mode', { perDocument: true });
    await sql`UPDATE deliveries SET pending_deletion_at=now(), pending_deletion_by_user_id=${managerId} WHERE id=${id}`;
    expect((await patch(id, `${link(docs[0]!)}/recipient`, { none: true })).statusCode).toBe(409);
    expect(
      (await patch(id, `${link(docs[0]!)}/purpose`, { purpose: 'realization' })).statusCode,
    ).toBe(409);
    expect((await patch(id, '/recipient-mode', { perDocument: false })).statusCode).toBe(409);
  });

  it('одновременное выключение режима и правка документа оставляют согласованное состояние', async () => {
    const id = await makeDelivery();
    await patch(id, '/recipient-mode', { perDocument: true });
    const [mode, recipient] = await Promise.all([
      patch(id, '/recipient-mode', { perDocument: false }),
      patch(id, `${link(docs[0]!)}/recipient`, { none: true }),
    ]);
    expect(mode.statusCode).toBe(200);
    expect([200, 409]).toContain(recipient.statusCode);
    const [row] = await sql<{ recipients_per_document: boolean; own_count: number }[]>`
      SELECT d.recipients_per_document,
        count(*) FILTER (WHERE ds.own_recipient OR ds.own_purpose)::int AS own_count
      FROM deliveries d JOIN delivery_sources ds ON ds.delivery_id=d.id
      WHERE d.id=${id} GROUP BY d.id`;
    expect(row).toMatchObject({ recipients_per_document: false, own_count: 0 });
  });
});
