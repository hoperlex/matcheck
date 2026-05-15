import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  LlmProviderDtoSchema,
  LlmProviderUpsertSchema,
  LlmTestResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildProviderFromRow } from '../../domain/llm/registry.js';

function dto(p: typeof llmProviders.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    isDefault: p.isDefault,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function llmProviderRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/admin/llm-providers',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(LlmProviderDtoSchema) } },
    },
    async () => {
      const rows = await app.db
        .select()
        .from(llmProviders)
        .orderBy(desc(llmProviders.isDefault), llmProviders.name);
      return rows.map(dto);
    },
  );

  app.post(
    '/api/v1/admin/llm-providers',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: LlmProviderUpsertSchema,
        response: { 201: LlmProviderDtoSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const [cred] = await app.db
        .select({ kind: llmProviderCredentials.kind })
        .from(llmProviderCredentials)
        .where(eq(llmProviderCredentials.kind, body.kind))
        .limit(1);
      if (!cred) {
        return reply.code(400).send({
          error: 'no_credentials_for_kind',
          message: `Не задан ключ для провайдера типа "${body.kind}". Откройте «Ключи провайдеров» и добавьте ключ.`,
        });
      }
      if (body.isDefault) {
        await app.db.update(llmProviders).set({ isDefault: false });
      }
      const [created] = await app.db
        .insert(llmProviders)
        .values({
          name: body.name,
          kind: body.kind,
          model: body.model,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          isDefault: body.isDefault,
          isActive: body.isActive,
        })
        .returning();
      if (!created) throw new Error('Failed to insert provider');
      reply.code(201);
      return dto(created);
    },
  );

  app.patch(
    '/api/v1/admin/llm-providers/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: LlmProviderUpsertSchema.partial(),
        response: { 200: LlmProviderDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (body.isDefault) {
        await app.db
          .update(llmProviders)
          .set({ isDefault: false })
          .where(sql`${llmProviders.id} <> ${req.params.id}`);
      }
      const patch: Partial<typeof llmProviders.$inferInsert> = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        updatedAt: new Date(),
      };
      const [updated] = await app.db
        .update(llmProviders)
        .set(patch)
        .where(eq(llmProviders.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return dto(updated);
    },
  );

  app.delete(
    '/api/v1/admin/llm-providers/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const del = await app.db
        .delete(llmProviders)
        .where(eq(llmProviders.id, req.params.id))
        .returning({ id: llmProviders.id });
      if (del.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/llm-providers/:id/test',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: LlmTestResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(llmProviders)
        .where(eq(llmProviders.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const provider = await buildProviderFromRow(row);
      const started = Date.now();
      const result = await provider.testConnection();
      return { ...result, durationMs: Date.now() - started };
    },
  );
}
