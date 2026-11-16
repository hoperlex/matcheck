/**
 * Группы приёмок: рейсы одной поставки в «Принятых» (миграция 0149).
 *
 * Только портал — `/sync` и мобильный клиент групп не знают. Сводка группы в
 * строке списка (`DeliveryGroupSummarySchema`) живёт в deliveries.ts рядом с
 * `DeliverySchema`, здесь — запросы и ответы маршрутов /delivery-groups.
 */
import { z } from 'zod';
import { DELIVERY_GROUP_MAX, DeliveryGroupRefSchema, DeliverySchema } from './deliveries.js';

const ids = (min: number, max: number) =>
  z
    .array(z.string().uuid())
    .min(min)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'Приёмка указана дважды');

/**
 * Одна операция над составом: создать группу (без `groupId`, `add` ≥ 2) или
 * применить к существующей добавления и удаления разом. `expectedMemberIds` —
 * состав, который видел человек: разошёлся с текущим → 409 `group_changed`.
 */
export const DeliveryGroupComposeRequestSchema = z
  .object({
    groupId: z.string().uuid().optional(),
    expectedMemberIds: ids(0, DELIVERY_GROUP_MAX).optional(),
    add: ids(0, DELIVERY_GROUP_MAX).default([]),
    remove: ids(0, DELIVERY_GROUP_MAX).default([]),
  })
  .refine(
    (body) => !body.add.some((id) => body.remove.includes(id)),
    'Приёмка одновременно добавляется и убирается',
  )
  .refine((body) => body.add.length + body.remove.length > 0, 'Нечего менять');
export type DeliveryGroupComposeRequest = z.input<typeof DeliveryGroupComposeRequestSchema>;

export const DeliveryGroupComposeResponseSchema = z.object({
  /** null — группа распущена (в ней осталось меньше двух приёмок). */
  groupId: z.string().uuid().nullable(),
  members: z.array(DeliveryGroupRefSchema),
  added: z.array(DeliveryGroupRefSchema),
  removed: z.array(DeliveryGroupRefSchema),
  dissolved: z.boolean(),
});
export type DeliveryGroupComposeResponse = z.infer<typeof DeliveryGroupComposeResponseSchema>;

export const DeliveryGroupLeaveRequestSchema = z.object({
  deliveryIds: ids(1, DELIVERY_GROUP_MAX),
});
export type DeliveryGroupLeaveRequest = z.infer<typeof DeliveryGroupLeaveRequestSchema>;

export const DeliveryGroupLeaveResponseSchema = z.object({
  removed: z.array(DeliveryGroupRefSchema),
  dissolvedGroupIds: z.array(z.string().uuid()),
});
export type DeliveryGroupLeaveResponse = z.infer<typeof DeliveryGroupLeaveResponseSchema>;

export const DeliveryGroupDissolveResponseSchema = z.object({
  removed: z.array(DeliveryGroupRefSchema),
});
export type DeliveryGroupDissolveResponse = z.infer<typeof DeliveryGroupDissolveResponseSchema>;

/**
 * Полный состав группы для привязки УПД: без списочных фильтров (чужие
 * черновики, поиск, страница). `items.length === memberIds.length` — иначе
 * клиент не начинает привязку.
 */
export const DeliveryGroupMembersResponseSchema = z.object({
  groupId: z.string().uuid(),
  siteId: z.string().uuid(),
  memberIds: z.array(z.string().uuid()),
  items: z.array(DeliverySchema),
});
export type DeliveryGroupMembersResponse = z.infer<typeof DeliveryGroupMembersResponseSchema>;

export const DELIVERY_GROUP_ERRORS = [
  'not_found',
  'group_not_found',
  'draft',
  'pending_deletion',
  'from_shipment',
  'in_other_group',
  'other_site',
  'too_many',
  'too_few',
  'group_changed',
] as const;
export type DeliveryGroupError = (typeof DELIVERY_GROUP_ERRORS)[number];

export const DeliveryGroupErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  deliveries: z.array(DeliveryGroupRefSchema).optional(),
});

/**
 * Привязка УПД из ЭДО ко всей группе: состав, который видел человек. Сервер
 * сверяет его под блокировкой группы и требует каждого участника в целях
 * (или с уже стоящей УПД) — иначе 409 `group_changed` / `group_incomplete`.
 */
export const EdoBatchDeliveryGroupSchema = z.object({
  id: z.string().uuid(),
  memberIds: z.array(z.string().uuid()).min(1).max(DELIVERY_GROUP_MAX),
});
export type EdoBatchDeliveryGroup = z.infer<typeof EdoBatchDeliveryGroupSchema>;
