import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  UserDtoSchema,
  UserAdminPatchSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { users } from '../../db/schema.js';

function dto(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    siteId: u.siteId,
    phone: u.phone,
    fullName: u.fullName,
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
        body: UserAdminPatchSchema,
        response: { 200: UserDtoSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(users)
        .where(eq(users.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      const nextRole = req.body.role ?? existing.role;
      if (req.body.role !== undefined) patch.role = req.body.role;
      if (req.body.isActive !== undefined) patch.isActive = req.body.isActive;
      // phone — опциональный, нормализуем: пустая строка → NULL, иначе trim.
      // Это упрощает мобильному клиенту проверку «есть телефон или нет»
      // (отсутствие → не показывать кнопку звонка в шапке материалов).
      if (req.body.phone !== undefined) {
        const trimmed = req.body.phone?.trim() ?? null;
        patch.phone = trimmed && trimmed.length > 0 ? trimmed : null;
      }

      // Нормализация siteId по итоговой роли: только inspector_kpp может иметь объект.
      // При смене роли на admin/manager — обнуляем, даже если в body пришёл UUID.
      // Для inspector_kpp пишем то, что пришло (включая null — это допустимое
      // промежуточное состояние «инспектор без объекта»).
      if (nextRole !== 'inspector_kpp') {
        patch.siteId = null;
      } else if (req.body.siteId !== undefined) {
        patch.siteId = req.body.siteId;
      }

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
