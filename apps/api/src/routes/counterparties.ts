import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, inArray, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { publishEvent } from './events.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  CounterpartyListResponseSchema,
  CounterpartySchema,
  CounterpartyUpsertSchema,
  ErrorResponseSchema,
  PLACEHOLDER_INN_PREFIX,
  isPlaceholderInn,
} from '@matcheck/contracts';
import { counterparties } from '../db/schema.js';

/**
 * Генератор placeholder-ИНН для контрагентов, созданных «на лету» без ИНН.
 * Формат: 0000 + 8 hex = 12 символов, помещается в varchar(12). Шанс
 * коллизии — 16^8 = ~4·10⁹ комбинаций, для нашего объёма безопасно.
 */
function generatePlaceholderInn(): string {
  return PLACEHOLDER_INN_PREFIX + randomBytes(4).toString('hex');
}

const ListQuerySchema = z.object({
  q: z.string().optional(),
  role: z.enum(['supplier', 'customer', 'contractor']).optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

function row(c: typeof counterparties.$inferSelect) {
  return {
    id: c.id,
    inn: c.inn,
    kpp: c.kpp,
    name: c.name,
    aliases: c.aliases ?? [],
    address: c.address,
    isSelf: c.isSelf,
    isSupplier: c.isSupplier,
    isCustomer: c.isCustomer,
    isContractor: c.isContractor,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function counterpartyRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/counterparties',
    {
      preHandler: [app.authenticate],
      schema: { querystring: ListQuerySchema, response: { 200: CounterpartyListResponseSchema } },
    },
    async (req) => {
      const { q, role, limit, offset } = req.query;
      const filters = [];
      if (q) {
        // Поиск по name / inn / aliases. aliases — массив текстов; используем
        // EXISTS с UNNEST + ILIKE, чтобы matching работал по любому из алиасов.
        filters.push(
          or(
            ilike(counterparties.name, `%${q}%`),
            ilike(counterparties.inn, `${q}%`),
            drSql`exists (select 1 from unnest(${counterparties.aliases}) as a(v) where a.v ilike ${'%' + q + '%'})`,
          ),
        );
      }
      if (role === 'supplier') filters.push(eq(counterparties.isSupplier, true));
      if (role === 'customer') filters.push(eq(counterparties.isCustomer, true));
      if (role === 'contractor') filters.push(eq(counterparties.isContractor, true));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select()
        .from(counterparties)
        .where(where)
        .orderBy(counterparties.name)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(counterparties)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/counterparties',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: CounterpartyUpsertSchema,
        // 200 — найден существующий (дедуп сработал, использован он).
        // 201 — создан новый.
        response: { 200: CounterpartySchema, 201: CounterpartySchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const trimmedName = body.name.trim();
      const lname = trimmedName.toLowerCase();
      const wantsRoles = {
        isSelf: body.isSelf ?? false,
        isSupplier: body.isSupplier ?? false,
        isCustomer: body.isCustomer ?? false,
        isContractor: body.isContractor ?? false,
      };

      // 1. Дедуп по ИНН: если ИНН передан и не плейсхолдер — ищем точное
      // совпадение. Если найден — добавляем недостающие роли и возвращаем.
      if (body.inn && !isPlaceholderInn(body.inn)) {
        const innMatchConds = [eq(counterparties.inn, body.inn)];
        if (body.kpp) innMatchConds.push(eq(counterparties.kpp, body.kpp));
        const [existing] = await app.db
          .select()
          .from(counterparties)
          .where(and(...innMatchConds))
          .limit(1);
        if (existing) {
          const patch: Partial<typeof counterparties.$inferInsert> = {};
          if (wantsRoles.isSupplier && !existing.isSupplier) patch.isSupplier = true;
          if (wantsRoles.isCustomer && !existing.isCustomer) patch.isCustomer = true;
          if (wantsRoles.isContractor && !existing.isContractor) patch.isContractor = true;
          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date();
            const [upd] = await app.db
              .update(counterparties)
              .set(patch)
              .where(eq(counterparties.id, existing.id))
              .returning();
            return upd ? row(upd) : row(existing);
          }
          return row(existing);
        }
      }

      // 2. Дедуп по lower(name) ИЛИ lower(any(aliases)). Тут же — апгрейд
      // плейсхолдер-ИНН на реальный, если он передан.
      const [byName] = await app.db
        .select()
        .from(counterparties)
        .where(
          or(
            drSql`lower(${counterparties.name}) = ${lname}`,
            drSql`exists (select 1 from unnest(${counterparties.aliases}) as a(v) where lower(a.v) = ${lname})`,
          ),
        )
        .limit(1);
      if (byName) {
        const patch: Partial<typeof counterparties.$inferInsert> = {};
        if (
          body.inn &&
          !isPlaceholderInn(body.inn) &&
          isPlaceholderInn(byName.inn)
        ) {
          // Апгрейд плейсхолдера на настоящий ИНН.
          patch.inn = body.inn;
          if (body.kpp !== undefined) patch.kpp = body.kpp ?? null;
        }
        if (wantsRoles.isSupplier && !byName.isSupplier) patch.isSupplier = true;
        if (wantsRoles.isCustomer && !byName.isCustomer) patch.isCustomer = true;
        if (wantsRoles.isContractor && !byName.isContractor) patch.isContractor = true;
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = new Date();
          const [upd] = await app.db
            .update(counterparties)
            .set(patch)
            .where(eq(counterparties.id, byName.id))
            .returning();
          return upd ? row(upd) : row(byName);
        }
        return row(byName);
      }

      // 3. Не нашли — создаём. Если ИНН не передан, генерируем плейсхолдер.
      const innToUse = body.inn ?? generatePlaceholderInn();
      try {
        const [created] = await app.db
          .insert(counterparties)
          .values({
            inn: innToUse,
            kpp: body.kpp ?? null,
            name: trimmedName,
            aliases: body.aliases ?? [],
            address: body.address ?? null,
            isSelf: wantsRoles.isSelf,
            isSupplier: wantsRoles.isSupplier,
            isCustomer: wantsRoles.isCustomer,
            isContractor: wantsRoles.isContractor,
          })
          .returning();
        if (!created) throw new Error('insert failed');
        reply.code(201);
        return row(created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unique')) {
          return reply.code(409).send({
            error: 'duplicate_inn_kpp',
            message: 'Counterparty with this INN/KPP already exists',
          });
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CounterpartyUpsertSchema.partial(),
        response: { 200: CounterpartySchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [updated] = await app.db
        .update(counterparties)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(counterparties.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      // SSE: мобила слушает counterparty_updated и дёргает /sync. Без
      // этого изменения наименования/ИНН/роли контрагента долетали до
      // мобилы только через periodic Worker (15 мин).
      publishEvent(app, {
        type: 'counterparty_updated',
        entityId: updated.id,
        ts: new Date().toISOString(),
      });
      return row(updated);
    },
  );

  app.delete(
    '/api/v1/counterparties/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const deleted = await app.db
        .delete(counterparties)
        .where(eq(counterparties.id, req.params.id))
        .returning({ id: counterparties.id });
      if (deleted.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  // Массовое удаление контрагентов. FK от source_documents/deliveries/
  // shipments на counterparties — все ON DELETE SET NULL, поэтому удалять
  // безопасно: ссылки в документах просто обнуляются. Не найденные ID
  // возвращаются как skipped.not_found.
  app.post(
    '/api/v1/counterparties/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const ids = req.body.ids;
      const deletedRows = await app.db
        .delete(counterparties)
        .where(inArray(counterparties.id, ids))
        .returning({ id: counterparties.id });
      const deletedSet = new Set(deletedRows.map((r) => r.id));
      const skipped = ids
        .filter((id) => !deletedSet.has(id))
        .map((id) => ({ id, reason: 'not_found' as const }));
      return { deleted: Array.from(deletedSet), skipped };
    },
  );
}
