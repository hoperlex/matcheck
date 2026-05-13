import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import { UserDtoSchema, UserRoleSchema, ErrorResponseSchema } from '@matcheck/contracts';
import { users } from '../../db/schema.js';

function dto(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

export async function userAdminRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/admin/users',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(UserDtoSchema) } },
    },
    async () => {
      const rows = await app.db.select().from(users).orderBy(desc(users.createdAt));
      return rows.map(dto);
    },
  );

  app.patch(
    '/api/v1/admin/users/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          role: UserRoleSchema.optional(),
          isActive: z.boolean().optional(),
        }),
        response: { 200: UserDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      if (req.body.role !== undefined) patch.role = req.body.role;
      if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
      const [updated] = await app.db
        .update(users)
        .set(patch)
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return dto(updated);
    },
  );
}
