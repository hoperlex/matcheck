import { z } from 'zod';

export const UserRoleSchema = z.enum(['admin', 'manager', 'inspector_kpp', 'contractor', 'monitor']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const EmailSchema = z.string().email().max(254).toLowerCase().trim();
export const PasswordSchema = z.string().min(8).max(256);
// Контактный телефон, опциональный. Без жёсткой валидации формата (E.164):
// пользователь вводит как удобно, нормализация для tel:URI — на клиенте.
// max 32 — запас под форматные символы (+ - () пробелы).
export const PhoneSchema = z.string().trim().max(32).nullable().optional();

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  fullName: z.string().min(1).max(200).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

// PhoneSchema (см. выше) используется только в UserDto и UserAdminPatch —
// телефон проставляется/правится админом через таблицу «Пользователи»
// в админ-разделе, форма регистрации не меняется (нужно лишь для роли
// manager, остальным опционально).

export const UserDtoSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: UserRoleSchema,
  isActive: z.boolean(),
  // Объект, привязанный к пользователю. Обязателен для inspector_kpp;
  // для admin/manager всегда null.
  siteId: z.string().uuid().nullable(),
  // Подрядчик (id из справочника customer_counterparties), привязанный к
  // пользователю. Обязателен для роли contractor; для остальных ролей null.
  contractorCustomerId: z.string().uuid().nullable(),
  // Контактный телефон (см. RegisterRequestSchema). null, если пользователь
  // не указал.
  phone: z.string().nullable(),
  // ФИО (Иванов Иван Иванович). null для пользователей, заведённых до
  // появления поля или не заполнивших его. Редактируется через «Личный
  // кабинет».
  fullName: z.string().nullable(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

// Профиль текущего юзера: то, что он может изменить о себе сам через ЛК.
// ФИО + контактный телефон. Email и роль через ЛК не меняются: email —
// это логин (нужна верификация), роль — прерогатива админа. Телефон
// нужен мобиле для кнопки звонка из шапки материалов; раньше его
// проставлял только админ, теперь менеджер может вписать сам.
export const UpdateProfileRequestSchema = z.object({
  fullName: z.string().trim().max(200).nullable(),
  phone: PhoneSchema,
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

// Смена пароля. Текущий пароль обязателен — защищает от случая, когда
// злоумышленник получил активную сессию: без знания текущего пароля он
// не сможет «угнать» учётку, сменив его.
export const ChangePasswordRequestSchema = z.object({
  currentPassword: PasswordSchema,
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const UserAdminPatchSchema = z.object({
  email: EmailSchema.optional(),
  role: UserRoleSchema.optional(),
  isActive: z.boolean().optional(),
  siteId: z.string().uuid().nullable().optional(),
  // Привязка к подрядчику (справочник customer_counterparties). Проставляется
  // админом для роли contractor; при смене роли на не-contractor обнуляется.
  contractorCustomerId: z.string().uuid().nullable().optional(),
  // Админ может править/проставлять телефон уже зарегистрированному
  // пользователю (например для менеджеров, которые регистрировались до
  // добавления поля или забыли заполнить).
  phone: PhoneSchema,
  // ФИО — для отображения в карточках и таблицах. null = «убрать ФИО».
  fullName: z.string().trim().max(200).nullable().optional(),
});
export type UserAdminPatch = z.infer<typeof UserAdminPatchSchema>;

// Смена пароля админом (без знания текущего пароля). Используется в
// разделе Администрирование → Пользователи. Защищено authorize('admin').
export const AdminSetPasswordRequestSchema = z.object({
  newPassword: PasswordSchema,
});
export type AdminSetPasswordRequest = z.infer<typeof AdminSetPasswordRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  user: UserDtoSchema,
  // Возвращаются только мобильным клиентам (X-Client-Type: mobile).
  // Веб использует HttpOnly-cookie и эти поля игнорирует.
  refreshToken: z.string().optional(),
  refreshExpiresIn: z.number().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
  refreshExpiresIn: z.number().optional(),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const RegisterResponseSchema = z.object({
  ok: z.literal(true),
  user: UserDtoSchema,
});

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
