import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  MailAccountDtoSchema,
  MailAccountPatchSchema,
  MailAccountUpsertSchema,
  MailPollQueuedSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { mailAccounts } from '../../db/schema.js';
import { buildAad, encryptToString } from '../../domain/auth/crypto.js';
import { runMailSyncForAccount } from '../../domain/jobs/mail-requests.js';

function dto(a: typeof mailAccounts.$inferSelect) {
  return {
    id: a.id,
    name: a.name,
    host: a.host,
    port: a.port,
    useTls: a.useTls,
    username: a.username,
    folder: a.folder,
    lastUid: a.lastUid,
    isActive: a.isActive,
    purpose: a.purpose,
    pollEnabled: a.pollEnabled,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function mailAccountRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/admin/mail-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(MailAccountDtoSchema) } },
    },
    async () => {
      const rows = await app.db.select().from(mailAccounts).orderBy(desc(mailAccounts.createdAt));
      return rows.map(dto);
    },
  );

  app.post(
    '/api/v1/admin/mail-accounts',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: MailAccountUpsertSchema.required({ password: true }),
        response: { 201: MailAccountDtoSchema },
      },
    },
    async (req, reply) => {
      const id = crypto.randomUUID();
      const encrypted = encryptToString(req.body.password, buildAad('mail_accounts', id));
      const [created] = await app.db
        .insert(mailAccounts)
        .values({
          id,
          name: req.body.name,
          host: req.body.host,
          port: req.body.port,
          useTls: req.body.useTls,
          username: req.body.username,
          passwordEncrypted: encrypted,
          folder: req.body.folder,
          isActive: req.body.isActive,
          purpose: req.body.purpose,
          pollEnabled: req.body.pollEnabled,
        })
        .returning();
      if (!created) throw new Error('Failed to insert mail account');
      reply.code(201);
      return dto(created);
    },
  );

  // Правка ящика без пересоздания — в первую очередь чтобы включать и
  // выключать автоопрос. Пароль трогаем только если его прислали.
  app.patch(
    '/api/v1/admin/mail-accounts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MailAccountPatchSchema,
        response: { 200: MailAccountDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { password, ...rest } = req.body;
      const patch: Partial<typeof mailAccounts.$inferInsert> = { ...rest, updatedAt: new Date() };
      if (password) {
        patch.passwordEncrypted = encryptToString(password, buildAad('mail_accounts', req.params.id));
      }
      const [updated] = await app.db
        .update(mailAccounts)
        .set(patch)
        .where(eq(mailAccounts.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return dto(updated);
    },
  );

  app.delete(
    '/api/v1/admin/mail-accounts/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const del = await app.db
        .delete(mailAccounts)
        .where(eq(mailAccounts.id, req.params.id))
        .returning({ id: mailAccounts.id });
      if (del.length === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/admin/mail-accounts/:id/sync',
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
        .from(mailAccounts)
        .where(eq(mailAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return runMailSyncForAccount(app, row);
    },
  );

  // «Проверить сейчас» для ящика с документами: ставит задачу в очередь
  // mail-poll, которую разбирает отдельный процесс mail-worker.
  //
  // Возвращает 202, а не результат: опрос идёт в другом процессе и может занять
  // десятки секунд — держать HTTP-запрос всё это время незачем. Работает и при
  // выключенном автоопросе: этим администратор проверяет доступы к ящику до
  // того, как включит постоянный опрос.
  app.post(
    '/api/v1/admin/mail-accounts/:id/poll',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          202: MailPollQueuedSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, req.params.id))
        .limit(1);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      if (row.purpose !== 'document') {
        return reply.code(400).send({
          error: 'wrong_purpose',
          message: 'Ящик заявок проверяется кнопкой «Синхронизировать»',
        });
      }
      if (!row.isActive) {
        return reply.code(400).send({ error: 'inactive', message: 'Ящик отключён' });
      }

      const job = await app.queues.mailPoll.add('poll', { accountId: row.id });
      reply.code(202);
      return { queued: true as const, jobId: String(job.id) };
    },
  );
}
