import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  ErrorResponseSchema,
  SiteListResponseSchema,
  SitePatchSchema,
  SiteSchema,
  SiteUpsertSchema,
} from '@matcheck/contracts';
import { sites, deliveries, SYSTEM_SITE_ID } from '../db/schema.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  activeOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  limit: z.coerce.number().int().positive().max(200).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(s: typeof sites.$inferSelect) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    fullName: s.fullName,
    address: s.address,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function siteRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/sites',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: SiteListResponseSchema } },
    },
    async (req) => {
      const { q, activeOnly, limit, offset } = req.query;
      const filters = [];
      if (q) {
        filters.push(or(ilike(sites.name, `%${q}%`), ilike(sites.code, `${q}%`)));
      }
      if (activeOnly) filters.push(eq(sites.isActive, true));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select()
        .from(sites)
        .where(where)
        .orderBy(sites.code)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(sites)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.get(
    '/api/v1/sites/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: SiteSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [s] = await app.db.select().from(sites).where(eq(sites.id, req.params.id)).limit(1);
      if (!s) return reply.code(404).send({ error: 'not_found' });
      return row(s);
    },
  );

  app.post(
    '/api/v1/sites',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: SiteUpsertSchema,
        response: { 201: SiteSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const [created] = await app.db
          .insert(sites)
          .values({
            code: req.body.code,
            name: req.body.name,
            fullName: req.body.fullName ?? null,
            address: req.body.address ?? null,
            isActive: req.body.isActive ?? true,
          })
          .returning();
        if (!created) throw new Error('insert failed');
        reply.code(201);
        return row(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique')) {
          return reply.code(409).send({
            error: 'duplicate_code',
            message: 'Объект с таким кодом уже существует',
          });
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/sites/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: SitePatchSchema,
        response: { 200: SiteSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (req.params.id === SYSTEM_SITE_ID) {
        return reply
          .code(409)
          .send({ error: 'system_site_readonly', message: 'Системный объект нельзя редактировать' });
      }
      try {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (req.body.code !== undefined) patch.code = req.body.code;
        if (req.body.name !== undefined) patch.name = req.body.name;
        if (req.body.fullName !== undefined) patch.fullName = req.body.fullName;
        if (req.body.address !== undefined) patch.address = req.body.address;
        if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
        const [updated] = await app.db
          .update(sites)
          .set(patch)
          .where(eq(sites.id, req.params.id))
          .returning();
        if (!updated) return reply.code(404).send({ error: 'not_found' });
        return row(updated);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique')) {
          return reply
            .code(409)
            .send({ error: 'duplicate_code', message: 'Объект с таким кодом уже существует' });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/sites/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.boolean() }),
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (req.params.id === SYSTEM_SITE_ID) {
        return reply
          .code(409)
          .send({ error: 'system_site_readonly', message: 'Системный объект нельзя удалить' });
      }
      // Жёсткое удаление только при отсутствии ссылок из приёмок.
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(deliveries)
        .where(eq(deliveries.siteId, req.params.id));
      if (count > 0) {
        return reply.code(409).send({
          error: 'has_references',
          message: `Невозможно удалить: объект используется в ${count} приёмках. Сделайте его неактивным.`,
        });
      }
      const deleted = await app.db
        .delete(sites)
        .where(eq(sites.id, req.params.id))
        .returning({ id: sites.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
