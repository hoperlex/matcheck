/**
 * Грузополучатель (графа 4 УПД) в проекции sourceDocuments у /sync.
 *
 * Что здесь ловится и не ловится больше нигде: /sync собирает УПД вручную,
 * а не через sdRow из routes/source-documents.ts, поэтому document-parties-api
 * может быть зелёным при полностью пустом поле на планшете — ровно так поле
 * и отсутствовало до этого фикса. Схема разрешает consigneeName как
 * .optional(), так что забытая строчка в проекции проходит валидацию молча.
 *
 * Три случая COALESCE(consignee_name_raw, counterparties.name):
 *   * raw перекрывает FK (графу 4 печатают без ИНН — это основной путь);
 *   * при пустом raw имя берётся из справочника;
 *   * оба пустые → null, а не undefined и не пустая строка.
 *
 * Как запускать — см. шапку photos-and-sync-scope.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRoutes } from '../../src/routes/sync.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('грузополучатель в /sync (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();
  const consigneeCpId = randomUUID();
  // ИНН уникален в пределах таблицы, а базу делят все интеграционные наборы —
  // константа падала бы при повторном прогоне.
  const consigneeInn = `78${String(Date.now()).slice(-8)}`;

  const docRawWinsId = randomUUID(); // raw + FK одновременно
  const docFkOnlyId = randomUUID(); // только FK
  const docEmptyId = randomUUID(); // ни того, ни другого

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
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
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`CNS${Date.now() % 10000}`}, 'Грузополучатель sync')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`cns-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name, is_customer)
              VALUES (${consigneeCpId}, ${consigneeInn}, NULL, 'ООО "ФСК Инжиниринг"', true)`;

    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, consignee_name_raw, consignee_id)
      VALUES (${docRawWinsId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'КА-1518', now(), 100, 'ООО «АЛЬЯНС»', ${consigneeCpId})`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, consignee_name_raw, consignee_id)
      VALUES (${docFkOnlyId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'УТ-6564', now(), 200, NULL, ${consigneeCpId})`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum)
      VALUES (${docEmptyId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'Б-1', now(), 300)`;

    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    } as unknown as AuthUser;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id = ${consigneeCpId}`;
    await sql.end({ timeout: 5 });
  });

  async function syncDocs(): Promise<Record<string, unknown>[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sourceDocuments: Record<string, unknown>[] }).sourceDocuments;
  }

  it('raw перекрывает FK: графу 4 печатают без ИНН, и она главнее справочника', async () => {
    const doc = (await syncDocs()).find((d) => d.id === docRawWinsId)!;
    expect(doc.consigneeName).toBe('ООО «АЛЬЯНС»');
    expect(doc.consigneeId).toBe(consigneeCpId);
  });

  it('при пустом raw имя берётся из справочника по consignee_id', async () => {
    const doc = (await syncDocs()).find((d) => d.id === docFkOnlyId)!;
    expect(doc.consigneeName).toBe('ООО "ФСК Инжиниринг"');
  });

  it('обе стороны пустые — null, а не undefined: клиент отличает «нет» от «не прислали»', async () => {
    const doc = (await syncDocs()).find((d) => d.id === docEmptyId)!;
    expect(doc).toHaveProperty('consigneeName');
    expect(doc.consigneeName).toBeNull();
    expect(doc.consigneeId).toBeNull();
  });
});
