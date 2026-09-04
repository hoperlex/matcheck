/**
 * Рубильник OPERATION_DOC_VALIDATION=0 — аварийный откат без деплоя фронта.
 *
 * Проверяется главное свойство: он гасит СРАЗУ ВСЁ, что построено на сводке —
 * и поле в DTO, и фильтр очереди. Наполовину выключённый рубильник оставил бы
 * пункт «Требует проверки», который никогда ничего не находит, и это выглядело
 * бы как сломанный фильтр, а не как выключенная возможность.
 *
 * Env подменяется ДО импорта роутов: loadEnv кэширует разбор окружения, и
 * статический import успел бы прочитать значение по умолчанию.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deliveries,
  deliveryItems,
  deliverySources,
  sessions,
  sites,
  sourceDocuments,
  sourceDocumentItems,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('OPERATION_DOC_VALIDATION=0 гасит сводку целиком (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const docId = randomUUID();
  const itemId = randomUUID();

  beforeAll(async () => {
    process.env.OPERATION_DOC_VALIDATION = '0';
    const { deliveryRoutes } = await import('../../src/routes/deliveries.js');

    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: {
        deliveries,
        deliveryItems,
        deliverySources,
        sessions,
        sites,
        sourceDocuments,
        sourceDocumentItems,
        statuses,
        users,
      },
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
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'IOF'}, 'Integration off')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`iof-${managerId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };

    // Документ с заведомо провалившейся проверкой — при включённом рубильнике
    // он дал бы и сводку, и попадание в очередь.
    const validation = {
      hasMismatch: true,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: 'row_qty_price',
          scope: { row: 1 },
          expected: 42941.57,
          actual: 6438.78,
          diff: 36502.79,
          tolerance: 42.94,
          ok: false,
        },
      ],
    };
    await sql`
      INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at, validation)
      VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, 'OFF-1', now(), '100.00', now(), ${JSON.stringify(validation)}::jsonb)`;
    await sql`
      INSERT INTO source_document_items (id, source_document_id, name_raw, qty, unit, line_no)
      VALUES (${itemId}, ${docId}, 'Воздуховод', '2', 'шт', 1)`;
  });

  afterAll(async () => {
    delete process.env.OPERATION_DOC_VALIDATION;
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function makeLinkedDelivery(): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: { statusCode: 'filled', siteId, items: [] },
    });
    const id = (created.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${id}/link-source`,
      payload: { sourceDocumentId: docId },
    });
    return id;
  }

  it('поля validation в DTO нет — ни в карточке, ни в списке', async () => {
    const deliveryId = await makeLinkedDelivery();

    const single = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}` });
    const singleDoc = (single.json() as { sourceDocuments: Record<string, unknown>[] })
      .sourceDocuments[0]!;
    expect('validation' in singleDoc).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/api/v1/deliveries?limit=50' });
    const fromList = (
      list.json() as { items: { id: string; sourceDocuments?: Record<string, unknown>[] }[] }
    ).items.find((d) => d.id === deliveryId);
    expect('validation' in (fromList!.sourceDocuments![0] ?? {})).toBe(false);
  });

  it('фильтр doc_attention выключен вместе со сводкой, а не отбирает пусто', async () => {
    const deliveryId = await makeLinkedDelivery();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/deliveries?limit=100&features=doc_attention',
    });
    const ids = (res.json() as { items: { id: string }[] }).items.map((d) => d.id);
    // Фильтр не сузил выборку: приёмка с расхождением на месте, как и все
    // остальные. Именно «выключено», а не «ничего не нашлось».
    expect(ids).toContain(deliveryId);
  });
});
