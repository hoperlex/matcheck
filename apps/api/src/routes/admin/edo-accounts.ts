import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  EdoAccountDtoSchema,
  EdoAccountUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { edoAccounts } from '../../db/schema.js';
import { buildAad, encryptToString, decryptField } from '../../domain/auth/crypto.js';
import { DiadocAdapter } from '../../domain/edo/diadoc.adapter.js';
import { runEdoSyncForAccount } from '../../domain/jobs/edo-poller.js';

function dto(a: typeof edoAccounts.$inferSelect) {
  return {
    id: a.id,
    provider: a.provider,
    name: a.name,
    isActive: a.isActive,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function edoAccountRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/admin/edo-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(EdoAccountDtoSchema) } },
    },
    async () => {
      const rows = await app.db.select().from(edoAccounts).orderBy(desc(edoAccounts.createdAt));
      return rows.map(dto);
    },
  );

  app.post(
    '/api/v1/admin/edo-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { body: EdoAccountUpsertSchema, response: { 201: EdoAccountDtoSchema } },
    },
    async (req, reply) => {
      const id = crypto.randomUUID();
      const encrypted = encryptToString(
        JSON.stringify(req.body.credentials),
        buildAad('edo_accounts', id),
      );
      const [created] = await app.db
        .insert(edoAccounts)
        .values({
          id,
          provider: req.body.provider,
          name: req.body.name,
          credentialsEncrypted: encrypted,
          isActive: req.body.isActive,
        })
        .returning();
      if (!created) throw new Error('Failed to insert edo_account');
      reply.code(201);
      return dto(created);
    },
  );

  app.delete(
    '/api/v1/admin/edo-accounts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const del = await app.db
        .delete(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .returning({ id: edoAccounts.id });
      if (del.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/edo-accounts/:id/sync',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ imported: z.number(), failed: z.number() }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(edoAccounts)
        .where(eq(edoAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      const creds = JSON.parse(
        decryptField(row.credentialsEncrypted, buildAad('edo_accounts', row.id)),
      ) as {
        apiClientId: string;
        login: string;
        password: string;
        boxId: string;
      };
      const adapter = new DiadocAdapter(creds);
      const result = await runEdoSyncForAccount(app, row, adapter);
      return result;
    },
  );
}
