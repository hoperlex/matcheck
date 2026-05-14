import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  PromptDtoSchema,
  PromptUpsertSchema,
  PromptPatchSchema,
  PromptDocKindSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { prompts } from '../../db/schema.js';
import { invalidatePromptCache } from '../../domain/prompts/registry.js';

function dto(p: typeof prompts.$inferSelect) {
  return {
    id: p.id,
    docKind: p.docKind as 'upd' | 'request',
    name: p.name,
    content: p.content,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function promptRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/admin/prompts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        querystring: z.object({ docKind: PromptDocKindSchema.optional() }),
        response: { 200: z.array(PromptDtoSchema) },
      },
    },
    async (req) => {
      const where = req.query.docKind ? eq(prompts.docKind, req.query.docKind) : undefined;
      const rows = await app.db
        .select()
        .from(prompts)
        .where(where)
        .orderBy(desc(prompts.isActive), desc(prompts.updatedAt));
      return rows.map(dto);
    },
  );

  app.post(
    '/api/v1/admin/prompts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: PromptUpsertSchema,
        response: { 201: PromptDtoSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const makeActive = body.isActive === true;
      const id = crypto.randomUUID();
      const created = await app.db.transaction(async (tx) => {
        if (makeActive) {
          await tx
            .update(prompts)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(prompts.docKind, body.docKind));
        }
        const [row] = await tx
          .insert(prompts)
          .values({
            id,
            docKind: body.docKind,
            name: body.name,
            content: body.content,
            isActive: makeActive,
          })
          .returning();
        return row;
      });
      if (!created) throw new Error('Failed to insert prompt');
      if (makeActive) invalidatePromptCache(body.docKind);
      reply.code(201);
      return dto(created);
    },
  );

  app.patch(
    '/api/v1/admin/prompts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: PromptPatchSchema,
        response: { 200: PromptDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(prompts)
        .where(eq(prompts.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const [updated] = await app.db
        .update(prompts)
        .set({
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.content !== undefined ? { content: req.body.content } : {}),
          updatedAt: new Date(),
        })
        .where(eq(prompts.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      if (updated.isActive) invalidatePromptCache(updated.docKind as 'upd' | 'request');
      return dto(updated);
    },
  );

  app.post(
    '/api/v1/admin/prompts/:id/activate',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: PromptDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [target] = await app.db
        .select()
        .from(prompts)
        .where(eq(prompts.id, req.params.id))
        .limit(1);
      if (!target) return reply.code(404).send({ error: 'not_found' });
      const activated = await app.db.transaction(async (tx) => {
        await tx
          .update(prompts)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(eq(prompts.docKind, target.docKind), eq(prompts.isActive, true)),
          );
        const [row] = await tx
          .update(prompts)
          .set({ isActive: true, updatedAt: new Date() })
          .where(eq(prompts.id, target.id))
          .returning();
        return row;
      });
      if (!activated) throw new Error('Failed to activate prompt');
      invalidatePromptCache(activated.docKind as 'upd' | 'request');
      return dto(activated);
    },
  );

  app.delete(
    '/api/v1/admin/prompts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(prompts)
        .where(eq(prompts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      if (row.isActive) {
        return reply
          .code(409)
          .send({ error: 'prompt_active', message: 'Нельзя удалить активный промпт' });
      }
      await app.db.delete(prompts).where(eq(prompts.id, req.params.id));
      return { ok: true as const };
    },
  );
}
