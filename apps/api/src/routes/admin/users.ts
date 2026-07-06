import type { FastifyInstance } from 'fastify';
import { desc, eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  UserDtoSchema,
  UserAdminPatchSchema,
  AdminSetPasswordRequestSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { users, sessions } from '../../db/schema.js';
import { hashPassword } from '../../domain/auth/password.js';
import { publishEvent } from '../events.js';

function dto(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    siteId: u.siteId,
    contractorCustomerId: u.contractorCustomerId,
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
        response: { 200: UserDtoSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
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
      // email — email уникальный, проверяем коллизию перед update.
      if (req.body.email !== undefined && req.body.email !== existing.email) {
        const [dup] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, req.body.email))
          .limit(1);
        if (dup && dup.id !== existing.id) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        patch.email = req.body.email;
      }
      // fullName — null = «убрать», иначе trim. Пустая строка тоже → null.
      if (req.body.fullName !== undefined) {
        const trimmed = req.body.fullName?.trim() ?? null;
        patch.fullName = trimmed && trimmed.length > 0 ? trimmed : null;
      }
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

      // Симметрично siteId: привязка к подрядчику только у роли contractor.
      // При смене роли на другую (в т.ч. monitor) — обнуляем: monitor ни к чему
      // не привязан, видит все объекты.
      if (nextRole !== 'contractor') {
        patch.contractorCustomerId = null;
      } else if (req.body.contractorCustomerId !== undefined) {
        patch.contractorCustomerId = req.body.contractorCustomerId;
      }

      const [updated] = await app.db
        .update(users)
        .set(patch)
        .where(eq(users.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });

      // Deploy-safety: смена роли на web-only (contractor/monitor) инвалидирует все
      // сессии юзера. Роль читается из БД на каждом запросе, а мобильный клиент
      // обрабатывает только 401 (на 403 залипает молча). Без инвалидации ошибочно
      // назначенная мобильному инспектору web-only-роль сломалась бы тихо (write→403,
      // sync-scope пуст). Инвалидация → мобилка ловит 401 → штатный разлогин → при
      // логине с мобилы получает понятный 403 «web-only». Механизм тот же, что при
      // смене пароля (см. routes/auth.ts). Архив на планшете не вайпится: wipe
      // завязан на смену siteId в /auth/me, а не на разлогин. Условие «был не-web-only
      // → стал web-only», чтобы не дёргать при переходах между web-only ролями.
      const isWebOnly = (r: string): boolean => r === 'contractor' || r === 'monitor';
      if (isWebOnly(nextRole) && !isWebOnly(existing.role)) {
        const now = new Date();
        await app.db
          .update(users)
          .set({ sessionsInvalidatedAt: now })
          .where(eq(users.id, updated.id));
        await app.db
          .update(sessions)
          .set({ invalidatedAt: now })
          .where(and(eq(sessions.userId, updated.id), isNull(sessions.invalidatedAt)));
      }
      // SSE: мобильному клиенту нужно мгновенно узнавать о смене
      // user.siteId (от этого зависит штамп объекта на фото 1 Этапа).
      // Эвент шлём только если что-то существенное изменилось — чтобы
      // не плодить лишние requestImmediateSync. siteId и isActive
      // достаточно: остальные поля (email/fullName/phone/role) на UI
      // мобилы напрямую не используются.
      const siteChanged = patch.siteId !== undefined && updated.siteId !== existing.siteId;
      const activeChanged =
        patch.isActive !== undefined && updated.isActive !== existing.isActive;
      if (siteChanged || activeChanged) {
        publishEvent(app, {
          type: 'user_updated',
          entityId: updated.id,
          ts: new Date().toISOString(),
        });
      }
      return dto(updated);
    },
  );

  // Смена пароля админом — без подтверждения текущего пароля. Защита
  // только authorize('admin'). Используется, когда пользователь забыл
  // пароль и не может пройти штатный «Восстановление пароля». В таблице
  // Администрирование → Пользователи это иконка-ключик в строке.
  app.post(
    '/api/v1/admin/users/:id/password',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: AdminSetPasswordRequestSchema,
        response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [existing] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const hash = await hashPassword(req.body.newPassword);
      const now = new Date();
      await app.db
        .update(users)
        .set({
          passwordHash: hash,
          passwordChangedAt: now,
          sessionsInvalidatedAt: now,
          // Сброс блокировки: админ сбрасывает пароль обычно именно потому,
          // что пользователь не может войти (в т.ч. залочен попытками). Без
          // этого юзер с новым паролем всё равно упёрся бы в lockedUntil.
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(users.id, existing.id));
      // Безопасность: админский сброс пароля убивает ВСЕ сессии пользователя
      // (это не «своя» сессия админа) — старые access/refresh-токены целевого
      // юзера перестают работать.
      await app.db
        .update(sessions)
        .set({ invalidatedAt: now })
        .where(and(eq(sessions.userId, existing.id), isNull(sessions.invalidatedAt)));
      return { ok: true as const };
    },
  );

  // Удаление пользователя — hard delete. Защита от удаления самого себя
  // (защита от случайного «удалю свой админ-аккаунт и потеряю доступ»).
  app.delete(
    '/api/v1/admin/users/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (req.user!.id === req.params.id) {
        return reply.code(400).send({ error: 'cannot_delete_self' });
      }
      const [existing] = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, req.params.id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      await app.db.delete(users).where(eq(users.id, existing.id));
      return { ok: true as const };
    },
  );
}
