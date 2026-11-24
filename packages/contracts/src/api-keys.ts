/**
 * Машинные ключи внешних систем (вкладка «Администрирование → API-доступ»).
 *
 * Ключ = client_id + секрет. Секрет показывается один раз — в ответе на
 * создание и на «Новый секрет»; в базе только его sha256, в списке его нет.
 */
import { z } from 'zod';

export const SCOPE_ONEC_READ = 'onec.deliveries:read';
export const SCOPE_ONEC_ACK = 'onec.deliveries:ack';
export const API_SCOPES = [SCOPE_ONEC_READ, SCOPE_ONEC_ACK] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  [SCOPE_ONEC_READ]: 'Чтение очереди и приёмок',
  [SCOPE_ONEC_ACK]: 'Подтверждение загрузки',
};

export const ApiKeyStatusSchema = z.enum(['active', 'expired', 'revoked']);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

export const ApiKeyDtoSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.string()),
  /** Есть ли право подтверждать загрузку (единственный пишущий метод API). */
  allowAck: z.boolean(),
  /** Ограничение по сетям; задаётся командой на сервере, здесь только для чтения. */
  allowedCidrs: z.array(z.string()).nullable(),
  status: ApiKeyStatusSchema,
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  /** Последнее обращение с этим ключом: запрос или получение токена. */
  lastUsedAt: z.string().nullable(),
  lastTokenIp: z.string().nullable(),
  /** Поколение секрета — передаётся в «Новый секрет» против двойного нажатия. */
  secretGeneration: z.number().int(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDtoSchema>;

const NameSchema = z.string().trim().min(1, 'Укажите название').max(100);
const DescriptionSchema = z.string().trim().max(1000);

export const ApiKeyCreateSchema = z.object({
  name: NameSchema,
  description: DescriptionSchema.optional(),
  allowAck: z.boolean(),
  /** ISO-8601; отсутствует или null — бессрочно. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

/** undefined — поле не меняем; expiresAt: null — сделать бессрочным. */
export const ApiKeyPatchSchema = z.object({
  name: NameSchema.optional(),
  description: DescriptionSchema.nullable().optional(),
  allowAck: z.boolean().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type ApiKeyPatch = z.infer<typeof ApiKeyPatchSchema>;

export const ApiKeyRotateSchema = z.object({
  /** Поколение, которое видел администратор; другое — 409 generation_changed. */
  expectedGeneration: z.number().int().min(1),
});

/** Ответ создания и «Нового секрета» — единственное место, где есть секрет. */
export const ApiKeySecretResponseSchema = z.object({
  key: ApiKeyDtoSchema,
  clientSecret: z.string(),
});
export type ApiKeySecretResponse = z.infer<typeof ApiKeySecretResponseSchema>;
