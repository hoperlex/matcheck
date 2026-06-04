import { z } from 'zod';

/**
 * Чат на публичной share-странице: внешний пользователь (без логина)
 * пишет вопрос, менеджер-автор ссылки видит уведомление в портале и
 * отвечает там же.
 */

export const ShareMessageSenderTypeSchema = z.enum(['external', 'manager']);
export type ShareMessageSenderType = z.infer<typeof ShareMessageSenderTypeSchema>;

/**
 * Сообщение, отдаваемое наружу (внутрь портала и на публичную страницу).
 * Email отправителя НЕ возвращается в публичных endpoint'ах — в публичной
 * выдаче поле всегда null. Менеджер видит email в защищённых endpoint'ах.
 */
export const ShareMessageSchema = z.object({
  id: z.string().uuid(),
  senderType: ShareMessageSenderTypeSchema,
  senderName: z.string().nullable(),
  senderEmail: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  isRead: z.boolean(),
});
export type ShareMessage = z.infer<typeof ShareMessageSchema>;

// ─── Публичная сторона (share-страница) ────────────────────────────────────

export const PublicShareMessageListResponseSchema = z.object({
  items: z.array(ShareMessageSchema),
});
export type PublicShareMessageListResponse = z.infer<
  typeof PublicShareMessageListResponseSchema
>;

export const PublicShareMessageCreateRequestSchema = z.object({
  senderName: z.string().trim().min(1).max(120),
  senderEmail: z.string().trim().email().max(200),
  body: z.string().trim().min(1).max(4000),
});
export type PublicShareMessageCreateRequest = z.infer<
  typeof PublicShareMessageCreateRequestSchema
>;

export const PublicShareMessageCreateResponseSchema = z.object({
  message: ShareMessageSchema,
});
export type PublicShareMessageCreateResponse = z.infer<
  typeof PublicShareMessageCreateResponseSchema
>;

// ─── Защищённая сторона (портал менеджера) ─────────────────────────────────

export const ShareMessageUnreadCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type ShareMessageUnreadCountResponse = z.infer<
  typeof ShareMessageUnreadCountResponseSchema
>;

/**
 * Превью треда в списке колокольчика. Один тред = одна share-ссылка.
 * entityLabel — человекочитаемое название («Приёмка УПД №1796» или
 * «Отгрузка авто P563РК97»), собирается на сервере при JOIN.
 */
export const ShareMessageThreadSummarySchema = z.object({
  tokenId: z.string().uuid(),
  entityType: z.enum(['delivery', 'shipment']),
  entityId: z.string().uuid(),
  entityLabel: z.string(),
  lastMessageAt: z.string(),
  lastSenderName: z.string(),
  lastBodyPreview: z.string(),
  unreadCount: z.number().int().nonnegative(),
  tokenRevokedAt: z.string().nullable(),
  tokenExpiresAt: z.string(),
});
export type ShareMessageThreadSummary = z.infer<typeof ShareMessageThreadSummarySchema>;

export const ShareMessageThreadListResponseSchema = z.object({
  items: z.array(ShareMessageThreadSummarySchema),
});
export type ShareMessageThreadListResponse = z.infer<
  typeof ShareMessageThreadListResponseSchema
>;

export const ShareMessageThreadDetailResponseSchema = z.object({
  thread: ShareMessageThreadSummarySchema,
  messages: z.array(ShareMessageSchema),
});
export type ShareMessageThreadDetailResponse = z.infer<
  typeof ShareMessageThreadDetailResponseSchema
>;

export const ManagerShareMessageCreateRequestSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type ManagerShareMessageCreateRequest = z.infer<
  typeof ManagerShareMessageCreateRequestSchema
>;

export const ManagerShareMessageCreateResponseSchema = z.object({
  message: ShareMessageSchema,
});
export type ManagerShareMessageCreateResponse = z.infer<
  typeof ManagerShareMessageCreateResponseSchema
>;
