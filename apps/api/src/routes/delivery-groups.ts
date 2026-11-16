/**
 * Группы приёмок (рейсы одной поставки) — маршруты портала.
 *
 * Права — как у отметки «Диспетчер»: действие «Проверять» у «Приёмок», по
 * умолчанию у менеджера и мониторинга, админ всегда. Инспектор, подрядчик и
 * наблюдатель — 403. Планшет эти маршруты не зовёт; строки `deliveries` они не
 * меняют, поэтому `/sync` ничего не замечает.
 *
 * Ядро — domain/operations/delivery-groups.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DeliveryGroupComposeRequestSchema,
  DeliveryGroupComposeResponseSchema,
  DeliveryGroupDissolveResponseSchema,
  DeliveryGroupErrorResponseSchema,
  DeliveryGroupLeaveRequestSchema,
  DeliveryGroupLeaveResponseSchema,
  DeliveryGroupMembersResponseSchema,
  ErrorResponseSchema,
  type Delivery,
  type DeliveryGroupError,
} from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import {
  composeDeliveryGroup,
  deliveryGroupComposition,
  dissolveDeliveryGroup,
  leaveDeliveryGroups,
  DeliveryGroupChangedError,
  type DeliveryRef,
} from '../domain/operations/delivery-groups.js';
import { publishEvent } from './events.js';

const IdParams = z.object({ id: z.string().uuid() });

/** «Приёмка 25518 …» / «Приёмки 25518, 25515 …». */
function deliveriesPhrase(list: readonly DeliveryRef[], one: string, many: string): string {
  const numbers = list.map((d) => d.displayId).join(', ');
  return list.length > 1 ? `Приёмки ${numbers} ${many}` : `Приёмка ${numbers} ${one}`;
}

/** Текст отказа — его и покажет окно. */
export function deliveryGroupErrorMessage(
  error: DeliveryGroupError,
  list: readonly DeliveryRef[],
): string {
  const text = (() => {
    switch (error) {
      case 'not_found':
        return 'Приёмка не найдена — обновите список';
      case 'group_not_found':
        return 'Группа уже распущена — обновите список';
      case 'draft':
        return deliveriesPhrase(list, '— черновик', '— черновики');
      case 'pending_deletion':
        return deliveriesPhrase(list, 'помечена на удаление', 'помечены на удаление');
      case 'from_shipment':
        return deliveriesPhrase(list, 'создана из отгрузки', 'созданы из отгрузки');
      case 'in_other_group':
        return deliveriesPhrase(list, 'уже в другой группе', 'уже в других группах');
      case 'other_site':
        return `${deliveriesPhrase(list, 'с другого объекта', 'с другого объекта')}: в группе только приёмки одного объекта`;
      case 'too_many':
        return 'В группе не больше 50 приёмок';
      case 'too_few':
        return 'Для группы нужны хотя бы две приёмки';
      case 'group_changed':
        return 'Состав группы изменился — откройте её заново';
    }
  })();
  return `${text}. Ничего не изменено.`;
}

const ERROR_CODE: Record<DeliveryGroupError, 400 | 404 | 409> = {
  not_found: 404,
  group_not_found: 404,
  draft: 409,
  pending_deletion: 409,
  from_shipment: 409,
  in_other_group: 409,
  other_site: 409,
  too_many: 409,
  too_few: 400,
  group_changed: 409,
};

type DtosBatch = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  ids: string[],
  viewerRole?: string | null,
) => Promise<Delivery[]>;

export function registerDeliveryGroupRoutes(rawApp: FastifyInstance, buildDtos: DtosBatch): void {
  const app = asZod(rawApp);
  const errors = {
    400: DeliveryGroupErrorResponseSchema,
    404: DeliveryGroupErrorResponseSchema,
    409: DeliveryGroupErrorResponseSchema,
  };

  const notify = (touched: ReadonlyArray<{ deliveryId: string; siteId: string }>) => {
    const ts = new Date().toISOString();
    const seen = new Set<string>();
    for (const { deliveryId, siteId } of touched) {
      if (seen.has(deliveryId)) continue;
      seen.add(deliveryId);
      publishEvent(app, { type: 'delivery_updated', entityId: deliveryId, siteId, ts });
    }
  };

  // Создать группу или применить к ней правки окна «Группа приёмок» — одной
  // операцией: «убрать одну и добавить другую» в группе из двух не распускает
  // её посередине.
  app.post(
    '/api/v1/delivery-groups',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        body: DeliveryGroupComposeRequestSchema,
        response: { 200: DeliveryGroupComposeResponseSchema, ...errors },
      },
    },
    async (req, reply) => {
      let result: Awaited<ReturnType<typeof composeDeliveryGroup>>;
      try {
        result = await app.db.transaction((tx) =>
          composeDeliveryGroup(tx, {
            userId: req.user?.id ?? null,
            groupId: req.body.groupId,
            expectedMemberIds: req.body.expectedMemberIds,
            add: req.body.add,
            remove: req.body.remove,
          }),
        );
      } catch (err) {
        if (!(err instanceof DeliveryGroupChangedError)) throw err;
        result = { status: 'group_changed', deliveries: [] };
      }
      if (result.status !== 'ok') {
        return reply.code(ERROR_CODE[result.status]).send({
          error: result.status,
          message: deliveryGroupErrorMessage(result.status, result.deliveries),
          deliveries: result.deliveries,
        });
      }
      notify(result.touched.map((deliveryId) => ({ deliveryId, siteId: result.siteId })));
      return {
        groupId: result.groupId,
        members: result.members,
        added: result.added,
        removed: result.removed,
        dissolved: result.dissolved,
      };
    },
  );

  // «Убрать из группы» по отмеченным строкам — приёмки могут быть из разных
  // групп. Приёмки без группы просто пропускаются.
  app.post(
    '/api/v1/delivery-groups/leave',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        body: DeliveryGroupLeaveRequestSchema,
        response: { 200: DeliveryGroupLeaveResponseSchema },
      },
    },
    async (req) => {
      const result = await app.db.transaction((tx) =>
        leaveDeliveryGroups(tx, req.body.deliveryIds),
      );
      notify(result.touched);
      return { removed: result.removed, dissolvedGroupIds: result.dissolvedGroupIds };
    },
  );

  app.delete(
    '/api/v1/delivery-groups/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        params: IdParams,
        response: {
          200: DeliveryGroupDissolveResponseSchema,
          404: DeliveryGroupErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await app.db.transaction((tx) => dissolveDeliveryGroup(tx, req.params.id));
      if (result.status !== 'ok') {
        return reply.code(404).send({
          error: 'group_not_found',
          message: deliveryGroupErrorMessage('group_not_found', []),
        });
      }
      notify(result.removed.map((m) => ({ deliveryId: m.deliveryId, siteId: result.siteId })));
      return { removed: result.removed };
    },
  );

  // Полный состав для привязки УПД ко всей группе: без списочных фильтров
  // (чужие черновики, поиск, страница) — иначе поток привязки увидел бы не
  // всех участников.
  app.get(
    '/api/v1/delivery-groups/:id/members',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'monitor')],
      schema: {
        params: IdParams,
        response: { 200: DeliveryGroupMembersResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const composition = await deliveryGroupComposition(app.db, req.params.id);
      if (!composition) {
        return reply.code(404).send({
          error: 'group_not_found',
          message: deliveryGroupErrorMessage('group_not_found', []),
        });
      }
      const memberIds = composition.members.map((m) => m.deliveryId);
      const items = await buildDtos(app, memberIds, req.user?.role);
      return { groupId: req.params.id, siteId: composition.siteId, memberIds, items };
    },
  );
}
