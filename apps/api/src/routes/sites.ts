import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { publishEvent } from './events.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ErrorResponseSchema,
  SiteListResponseSchema,
  SitePatchSchema,
  SiteSchema,
  SiteUpsertSchema,
} from '@matcheck/contracts';
import { isNotNull } from 'drizzle-orm';
import { sites, deliveries, SYSTEM_SITE_ID } from '../db/schema.js';
import type { Db } from '../db/client.js';

// Объект «из ФОТ» — это запись с fot_site_id IS NOT NULL (см. миграцию
// 0054). Через UI такие нельзя править/удалять: name/address приходят
// из централизованного источника заказчика, локальные правки затёрло бы
// следующим обновлением. Аналог isFotResponsiblePerson для МОЛ.
async function isFotSite(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, id), isNotNull(sites.fotSiteId)))
    .limit(1);
  return row != null;
}

async function filterFotSiteIds(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(inArray(sites.id, ids), isNotNull(sites.fotSiteId)));
  return rows.map((r) => r.id);
}

const ListQuerySchema = z.object({
  q: z.string().optional(),
  activeOnly: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  limit: z.coerce.number().int().positive().max(500).default(100),
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
      // Справочник объектов заказчика — подрядчику не показываем; название
      // объекта он получает в scoped-DTO своих записей (siteName).
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
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
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
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
      if (await isFotSite(app.db, req.params.id)) {
        return reply.code(409).send({
          error: 'fot_readonly',
          message: 'Объект из централизованного справочника нельзя редактировать в MATCHECK',
        });
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
        // SSE: мобила слушает site_updated и дёргает /sync. Без этого
        // переименование объекта / смена кода долетали до мобилы только
        // через periodic Worker.
        publishEvent(app, {
          type: 'site_updated',
          entityId: updated.id,
          ts: new Date().toISOString(),
        });
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
      if (await isFotSite(app.db, req.params.id)) {
        return reply.code(409).send({
          error: 'fot_readonly',
          message: 'Объект из централизованного справочника нельзя удалить в MATCHECK',
        });
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

  // Массовое удаление объектов. Учитывает три правила, что и одиночное:
  //  - системный объект (SYSTEM_SITE_ID) удалять нельзя → system_readonly;
  //  - объект, на который ссылаются deliveries → has_references;
  //  - объект не найден → not_found.
  // Те, что прошли проверки, удаляются одним DELETE WHERE id IN (...).
  app.post(
    '/api/v1/sites/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const skipped: Array<{
        id: string;
        reason: 'system_readonly' | 'has_references' | 'not_found' | 'internal_error';
      }> = [];

      // 1) System sites.
      const systemIds = ids.filter((id) => id === SYSTEM_SITE_ID);
      for (const id of systemIds) skipped.push({ id, reason: 'system_readonly' });

      // 1b) ФОТ-объекты. Тоже помечаем system_readonly (BulkDelete reason
      //     enum не содержит fot_readonly; смысл «эту запись не положено
      //     удалять руками» совпадает).
      const idsNoSystem = ids.filter((id) => id !== SYSTEM_SITE_ID);
      const fotIds = await filterFotSiteIds(app.db, idsNoSystem);
      const fotSet = new Set(fotIds);
      for (const id of fotIds) skipped.push({ id, reason: 'system_readonly' });

      // 2) Существование.
      const candidates = idsNoSystem.filter((id) => !fotSet.has(id));
      const existingRows = candidates.length
        ? await app.db
            .select({ id: sites.id })
            .from(sites)
            .where(inArray(sites.id, candidates))
        : [];
      const existingSet = new Set(existingRows.map((r) => r.id));
      for (const id of candidates) {
        if (!existingSet.has(id)) skipped.push({ id, reason: 'not_found' });
      }

      // 3) Привязки к приёмкам — пакетный COUNT по siteId.
      const checkable = candidates.filter((id) => existingSet.has(id));
      const refRows = checkable.length
        ? await app.db
            .select({
              siteId: deliveries.siteId,
              count: drSql<number>`count(*)::int`,
            })
            .from(deliveries)
            .where(inArray(deliveries.siteId, checkable))
            .groupBy(deliveries.siteId)
        : [];
      const refSet = new Set(
        refRows.filter((r) => Number(r.count) > 0).map((r) => r.siteId).filter((x): x is string => !!x),
      );
      const safeToDelete = checkable.filter((id) => !refSet.has(id));
      for (const id of checkable) {
        if (refSet.has(id)) skipped.push({ id, reason: 'has_references' });
      }

      // 4) Удаление.
      const deletedRows = safeToDelete.length
        ? await app.db
            .delete(sites)
            .where(inArray(sites.id, safeToDelete))
            .returning({ id: sites.id })
        : [];
      const deleted = deletedRows.map((r) => r.id);

      return { deleted, skipped };
    },
  );
}
