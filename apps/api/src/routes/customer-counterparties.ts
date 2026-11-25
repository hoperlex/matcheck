import type { FastifyInstance } from 'fastify';
import { eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { escapeLike } from '../lib/like.js';
import { siteScopeOf } from '../lib/site-scope.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  CustomerCounterpartyListResponseSchema,
  CustomerCounterpartySchema,
  CustomerCounterpartyUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { customerCounterparties } from '../db/schema.js';
import type { AuthUser } from '../plugins/auth.js';
import {
  applyCardSites,
  ContractorSitesCardError,
  EMPTY_SITES,
  loadContractorSites,
  type SitesViewer,
} from '../domain/contractor-sites/card.js';

// Справочник контрагентов заказчика (см. schema.ts / миграция 0055).
// ОТДЕЛЬНАЯ таблица `customer_counterparties`, не путать с операционной
// `counterparties` — на приёмки/отгрузки/мобилу не влияет.
//
// Связи «объект → вид» (0159, domain/contractor-sites/card.ts): в списке —
// только по ?withSites=1 (страница справочника), в ответах POST/PATCH — всегда.
const ListQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).default(2000),
  offset: z.coerce.number().int().nonnegative().default(0),
  withSites: z.enum(['0', '1']).optional(),
});

function row(c: typeof customerCounterparties.$inferSelect) {
  return {
    id: c.id,
    inn: c.inn,
    name: c.name,
    aliases: c.aliases ?? [],
    address: c.address,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function viewerOf(user: AuthUser | undefined): SitesViewer {
  return { role: user?.role ?? '', siteScope: siteScopeOf(user) };
}

export async function customerCounterpartyRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/customer-counterparties',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: CustomerCounterpartyListResponseSchema },
      },
    },
    async (req) => {
      const { q, limit, offset, withSites } = req.query;
      const like = q ? escapeLike(q) : '';
      const where = q
        ? or(
            ilike(customerCounterparties.name, `%${like}%`),
            ilike(customerCounterparties.inn, `${like}%`),
            drSql`exists (select 1 from unnest(${customerCounterparties.aliases}) as a(v) where a.v ilike ${'%' + like + '%'})`,
          )
        : undefined;
      const rows = await app.db
        .select()
        .from(customerCounterparties)
        .where(where)
        .orderBy(customerCounterparties.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(customerCounterparties)
        .where(where);
      if (withSites !== '1') return { items: rows.map(row), total: count };
      // Связей на бою ~150 строк: вся таблица дешевле IN на 5000 id.
      const linked = await loadContractorSites(app.db, 'all', viewerOf(req.user));
      return {
        items: rows.map((c) => ({ ...row(c), ...(linked.get(c.id) ?? EMPTY_SITES) })),
        total: count,
      };
    },
  );

  app.post(
    '/api/v1/customer-counterparties',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: CustomerCounterpartyUpsertSchema,
        response: { 201: CustomerCounterpartySchema, 422: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const b = req.body;
      try {
        const out = await app.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(customerCounterparties)
            .values({
              inn: (b.inn ?? '').trim(),
              name: b.name.trim(),
              aliases: b.aliases ?? [],
              address: b.address ?? null,
            })
            .returning();
          if (!created) throw new Error('insert failed');
          if (b.sites && b.sites.length > 0) {
            await applyCardSites(tx, {
              ccId: created.id,
              items: b.sites,
              version: null,
              requireVersion: false,
              userId: req.user?.id ?? null,
            });
          }
          const linked = await loadContractorSites(tx, [created.id], viewerOf(req.user));
          return { ...row(created), ...(linked.get(created.id) ?? EMPTY_SITES) };
        });
        reply.code(201);
        return out;
      } catch (err) {
        if (err instanceof ContractorSitesCardError)
          return reply.code(422).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/customer-counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CustomerCounterpartyUpsertSchema.partial(),
        response: {
          200: CustomerCounterpartySchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const patch: Partial<typeof customerCounterparties.$inferInsert> = { updatedAt: new Date() };
      if (b.inn !== undefined) patch.inn = (b.inn ?? '').trim();
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.aliases !== undefined) patch.aliases = b.aliases;
      if (b.address !== undefined) patch.address = b.address;
      try {
        const out = await app.db.transaction(async (tx) => {
          // UPDATE строки контрагента — всегда первым: строковая блокировка
          // выстраивает карточки одного контрагента в очередь, а ROW EXCLUSIVE
          // на таблице не совместим с SHARE импорта связей (card.ts).
          const [updated] = await tx
            .update(customerCounterparties)
            .set(patch)
            .where(eq(customerCounterparties.id, req.params.id))
            .returning();
          if (!updated) return null;
          if (b.sites !== undefined) {
            await applyCardSites(tx, {
              ccId: updated.id,
              items: b.sites,
              version: b.sitesVersion,
              requireVersion: true,
              userId: req.user?.id ?? null,
            });
          }
          const linked = await loadContractorSites(tx, [updated.id], viewerOf(req.user));
          return { ...row(updated), ...(linked.get(updated.id) ?? EMPTY_SITES) };
        });
        if (!out) return reply.code(404).send({ error: 'not_found' });
        return out;
      } catch (err) {
        if (err instanceof ContractorSitesCardError)
          return reply.code(err.status).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/customer-counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      // Связи с объектами (customer_counterparty_sites) уходят каскадом.
      const deleted = await app.db
        .delete(customerCounterparties)
        .where(eq(customerCounterparties.id, req.params.id))
        .returning({ id: customerCounterparties.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/customer-counterparties/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: BulkDeleteRequestSchema, response: { 200: BulkDeleteResponseSchema } },
    },
    async (req) => {
      const ids = req.body.ids;
      const deletedRows = await app.db
        .delete(customerCounterparties)
        .where(inArray(customerCounterparties.id, ids))
        .returning({ id: customerCounterparties.id });
      const deletedSet = new Set(deletedRows.map((r) => r.id));
      const skipped = ids
        .filter((id) => !deletedSet.has(id))
        .map((id) => ({ id, reason: 'not_found' as const }));
      return { deleted: Array.from(deletedSet), skipped };
    },
  );
}
