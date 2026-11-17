import type { FastifyInstance } from 'fastify';
import { desc, eq, and, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  UserDtoSchema,
  UserAdminPatchSchema,
  AdminSetPasswordRequestSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { users, sessions, sites, userSites } from '../../db/schema.js';
import { loadUserSiteIds, replaceUserSites } from '../../domain/auth/user-sites.js';
import { hashPassword } from '../../domain/auth/password.js';
import { applyPasswordHash } from '../../domain/auth/apply-password.js';
import { publishEvent } from '../events.js';
import { isMatrixOnlyRole, isWebOnlyRole } from '../../lib/roles.js';

function dto(u: typeof users.$inferSelect, siteIds: string[] = []) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    siteId: u.siteId,
    // Объекты наблюдателя; у остальных ролей строк в user_sites нет.
    siteIds: u.role === 'observer' ? siteIds : [],
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
      const siteIdsByUser = await loadUserSiteIds(
        app.db,
        rows.filter((u) => u.role === 'observer').map((u) => u.id),
      );
      return rows.map((u) => dto(u, siteIdsByUser.get(u.id) ?? []));
    },
  );

  app.patch(
    '/api/v1/admin/users/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UserAdminPatchSchema,
        response: {
          200: UserDtoSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
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

      // Объекты наблюдателя — только у итоговой роли observer. Уходит из роли —
      // список очищается (как siteId у инспектора). Добавлять можно лишь
      // существующие активные объекты; уже назначенный и с тех пор
      // деактивированный остаётся, если админ его не снял.
      let nextSiteIds: string[] | null = null;
      if (nextRole === 'observer') {
        if (req.body.siteIds !== undefined) nextSiteIds = [...new Set(req.body.siteIds)];
      } else if (existing.role === 'observer') {
        nextSiteIds = [];
      }
      if (nextSiteIds && nextSiteIds.length > 0) {
        const current = new Set(
          (await loadUserSiteIds(app.db, [existing.id])).get(existing.id) ?? [],
        );
        const found = await app.db
          .select({ id: sites.id, isActive: sites.isActive })
          .from(sites)
          .where(inArray(sites.id, nextSiteIds));
        const byId = new Map(found.map((r) => [r.id, r.isActive]));
        const bad = nextSiteIds.filter(
          (id) => !byId.has(id) || (!byId.get(id) && !current.has(id)),
        );
        if (bad.length > 0) {
          return reply.code(400).send({
            error: 'site_not_available',
            message: 'Объект не найден или неактивен',
          });
        }
      }

      const result = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set(patch)
          .where(eq(users.id, req.params.id))
          .returning();
        if (!row) return null;
        const sitesChanged =
          nextSiteIds !== null ? await replaceUserSites(tx, row.id, nextSiteIds) : false;
        const siteIds =
          row.role === 'observer'
            ? (
                await tx
                  .select({ siteId: userSites.siteId })
                  .from(userSites)
                  .where(eq(userSites.userId, row.id))
              )
                .map((r) => r.siteId)
                .sort()
            : [];
        return { row, sitesChanged, siteIds };
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      const updated = result.row;

      // Deploy-safety: смена роли на web-only (contractor/monitor/observer)
      // инвалидирует все сессии юзера. Роль читается из БД на каждом запросе, а
      // мобильный клиент обрабатывает только 401 (на 403 залипает молча). Без
      // инвалидации ошибочно назначенная мобильному инспектору web-only-роль
      // сломалась бы тихо (write→403, sync-scope пуст). Инвалидация → мобилка ловит
      // 401 → штатный разлогин → при логине с мобилы получает понятный 403
      // «web-only». Механизм тот же, что при смене пароля (см. routes/auth.ts).
      // Архив на планшете не вайпится: wipe завязан на смену siteId в /auth/me, а не
      // на разлогин. Базовое условие — «был не-web-only → стал web-only», чтобы не
      // дёргать при переходах между web-only ролями.
      //
      // ОТДЕЛЬНО — переходы из/в matrix-only роль (observer) в ЛЮБУЮ сторону. У неё
      // нет базовых прав вовсе: набор доступного меняется целиком, а не в деталях.
      // Особенно важен обратный переход observer → manager: базовое условие его не
      // покрывает (обе стороны... точнее, целевая роль не web-only), и без этой ветки
      // откат роли оставил бы живые сессии — тот самый случай, ради которого перед
      // возвратом старого кода приходится деактивировать людей вручную.
      const roleClassChanged =
        (isWebOnlyRole(nextRole) && !isWebOnlyRole(existing.role)) ||
        isMatrixOnlyRole(nextRole) !== isMatrixOnlyRole(existing.role);
      // Смена объектов наблюдателя тоже гасит его сессии. Сервер читает список
      // на каждом запросе, так что доступ меняется и без этого; но открытая
      // вкладка держит в памяти и в IndexedDB данные прежних объектов, а
      // повторный вход её гарантированно перезагружает.
      if (roleClassChanged || (result.sitesChanged && nextRole === 'observer')) {
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
      if (siteChanged || activeChanged || result.sitesChanged) {
        publishEvent(app, {
          type: 'user_updated',
          entityId: updated.id,
          ts: new Date().toISOString(),
        });
      }
      return dto(updated, result.siteIds);
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
      // bcrypt считается до транзакции: держать на нём соединение и блокировку
      // строки незачем. Дальше общая функция — та же, что применяет пароль,
      // заданный человеком по ссылке из письма админа. Она гасит ВСЕ сессии
      // (это не «своя» сессия админа), обнуляет серию неудачных входов вместе
      // с исторической блокировкой и закрывает открытую заявку на сброс.
      const hash = await hashPassword(req.body.newPassword);
      await applyPasswordHash(app.db, existing.id, hash, {
        event: 'password_set_by_admin',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
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
