import { z } from 'zod';
import { EmailSchema, PasswordSchema } from './auth.js';

/**
 * Самообслуживаемый сброс пароля.
 *
 * Токен НИГДЕ не ездит в пути URL: ссылка выглядит как
 * `https://<host>/reset-password#<token>`, фрагмент вообще не уходит на сервер,
 * а публичные роуты принимают токен в теле запроса. Тела Sentry маскирует по
 * ключу `token`, пути — нет.
 */

// ─── Публичная часть (префикс /api/v1/public/) ────────────────────────────

export const PasswordResetRequestSchema = z.object({ email: EmailSchema });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

// Ответ намеренно один и тот же для существующего и неизвестного email:
// иначе форма превращается в проверялку «есть ли у вас такой сотрудник».
export const PasswordResetRequestResponseSchema = z.object({ ok: z.literal(true) });
export type PasswordResetRequestResponse = z.infer<typeof PasswordResetRequestResponseSchema>;

// min(20) — как у share-токенов: принимаем и текущие 43 символа (32 байта
// base64url), и любые будущие длины, не ломая старые ссылки.
export const ResetTokenSchema = z.string().min(20).max(128);

export const PasswordResetInspectRequestSchema = z.object({ token: ResetTokenSchema });
export type PasswordResetInspectRequest = z.infer<typeof PasswordResetInspectRequestSchema>;

// Email нужен, чтобы человек видел, чей пароль меняет: ссылку ему переслали в
// мессенджере, и без подписи он не отличит свою от чужой.
export const PasswordResetInspectResponseSchema = z.object({ email: z.string() });
export type PasswordResetInspectResponse = z.infer<typeof PasswordResetInspectResponseSchema>;

export const PasswordResetConsumeRequestSchema = z.object({
  token: ResetTokenSchema,
  newPassword: PasswordSchema,
});
export type PasswordResetConsumeRequest = z.infer<typeof PasswordResetConsumeRequestSchema>;

export const PasswordResetConsumeResponseSchema = z.object({ ok: z.literal(true) });
export type PasswordResetConsumeResponse = z.infer<typeof PasswordResetConsumeResponseSchema>;

// ─── Админская часть ──────────────────────────────────────────────────────

/**
 * Метаданные для таблицы «Пользователи». Ни токена, ни готового URL здесь нет:
 * держать ключи от всех аккаунтов в памяти браузера и кэше React Query незачем.
 * Ссылку отдаёт отдельный `reveal` — по одной и под запись в аудит.
 *
 * Строка появляется и когда есть только заявка (админ ещё не выписал ссылку),
 * и когда есть только ссылка (админ выписал по звонку, без заявки).
 */
export const PasswordResetStateSchema = z.object({
  userId: z.string().uuid(),
  requestId: z.string().uuid().nullable(),
  requestedAt: z.string().nullable(),
  linkId: z.string().uuid().nullable(),
  linkExpiresAt: z.string().nullable(),
  hasActiveLink: z.boolean(),
});
export type PasswordResetState = z.infer<typeof PasswordResetStateSchema>;

export const PasswordResetStateListResponseSchema = z.object({
  items: z.array(PasswordResetStateSchema),
});
export type PasswordResetStateListResponse = z.infer<typeof PasswordResetStateListResponseSchema>;

export const PasswordResetLinkSchema = z.object({
  linkId: z.string().uuid(),
  url: z.string(),
  expiresAt: z.string(),
});
export type PasswordResetLink = z.infer<typeof PasswordResetLinkSchema>;

export const PasswordResetOkResponseSchema = z.object({ ok: z.literal(true) });
export type PasswordResetOkResponse = z.infer<typeof PasswordResetOkResponseSchema>;
