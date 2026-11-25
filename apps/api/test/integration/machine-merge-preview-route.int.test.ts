/**
 * Предпросмотр «Объединить в одну машину» через настоящий маршрут и сериализатор.
 *
 * Зачем отдельно от machine-merge.int.test.ts: тот зовёт домен напрямую, а
 * ответ маршрута сериализуется схемой (fastify-type-provider-zod отдаёт
 * результат разбора). Предупреждение, которого нет в схеме ответа, уронило бы
 * предпросмотр — окно объединения не открылось бы вовсе. Это видно только
 * через app.inject.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/instrument.js', () => ({}));

// Окружение читается и кешируется при импорте модулей (loadEnv) — до маршрута.
const env = vi.hoisted(() => {
  const site = globalThis.crypto.randomUUID();
  process.env.GROUPS_ROLLOUT = '1';
  delete process.env.GROUPS_ROLLOUT_SINCE;
  process.env.GROUP_CLAIM_SITES = site;
  process.env.MACHINE_MERGE_SITES = site;
  return { site };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('POST machine-merge/preview (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  const site = env.site;
  const supplierA = randomUUID();
  const supplierB = randomUUID();
  const manager: AuthUser = {
    id: randomUUID(),
    role: 'manager',
    siteId: null,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  };

  /** Отправка с портала из одного УПД поставщика [supplierId]. */
  async function seedUpload(supplierId: string): Promise<string> {
    const root = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status, kind,
            assembly_version, active_upload_generation, expected_date)
            VALUES (${root}, ${`mp${root.replace(/-/g, '')}`.slice(0, 64)}, 'inbound', ${site},
                    'parsed', 'mixed', 'legacy', 0, '2026-11-25')`;
    await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
            VALUES (${root}, 'public', ${randomUUID().slice(0, 20)})`;
    const id = randomUUID();
    await sql`INSERT INTO source_documents (id, kind, is_technical, direction, origin, status,
            site_id, parsed_at, doc_number, doc_date, total_sum, bundle_id, expected_date,
            supplier_directory_id)
            VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${site}, now(),
                    ${`MP-${id.slice(0, 6)}`}, now(), 100, ${root}, '2026-11-25', ${supplierId})`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema, casing: 'snake_case' });
    const { machineMergeRoutes } =
      await import('../../src/routes/source-document-machine-merge.js');

    await sql`INSERT INTO sites (id, code, name) VALUES (${site}, ${`MP${Date.now() % 100000}`}, 'Объект превью')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierA}, ${`75${String(Date.now()).slice(-8)}`}, 'ООО «Альтернатива»')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierB}, ${`76${String(Date.now()).slice(-8)}`}, 'ООО «Гаскар»')`;

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
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
    await app.register(machineMergeRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (!sql) return;
    await app?.close();
    await sql`DELETE FROM source_documents WHERE site_id = ${site}`;
    await sql`DELETE FROM ingest_events WHERE bundle_id IN (SELECT id FROM source_bundles WHERE site_id = ${site})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${site}`;
    await sql`DELETE FROM suppliers WHERE id IN (${supplierA}, ${supplierB})`;
    await sql`DELETE FROM sites WHERE id = ${site}`;
    await sql.end();
  });

  it('разные поставщики — объединить можно, предупреждение доходит целиком', async () => {
    const a = await seedUpload(supplierA);
    const b = await seedUpload(supplierB);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/source-documents/machine-merge/preview',
      payload: { documentIds: [a, b] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      blockers: unknown[];
      blockerMessages: string[];
      warnings: Array<{
        code: string;
        values?: Array<{ label: string | null; documentIds: string[] }>;
      }>;
      documentIds: string[];
    };
    expect(body.blockers).toEqual([]);
    expect(body.blockerMessages).toEqual([]);
    expect(body.documentIds.sort()).toEqual([a, b].sort());
    const warning = body.warnings.find((w) => w.code === 'different_suppliers');
    expect(warning?.values?.map((v) => v.label).sort()).toEqual([
      'ООО «Альтернатива»',
      'ООО «Гаскар»',
    ]);
    expect(warning?.values?.flatMap((v) => v.documentIds).sort()).toEqual([a, b].sort());
  });
});
