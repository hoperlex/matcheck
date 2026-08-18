import { sql, desc } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  bigint,
  bigserial,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { UpdValidation } from '@matcheck/contracts';

// ─── Enums ─────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', [
  'admin',
  'manager',
  'inspector_kpp',
  'contractor',
  'monitor',
  'observer',
]);
export const shipmentKindEnum = pgEnum('shipment_kind', [
  'contractor',
  'return',
  'transfer',
  'writeoff',
]);
// Тип позиции документа: обычный материал или ОС (основное средство).
// См. миграцию 0029. Constraint на согласованность asset_id/material_id —
// на уровне таблиц delivery_items / shipment_items.
export const itemKindEnum = pgEnum('item_kind', ['material', 'asset']);
export const sourceKindEnum = pgEnum('source_kind', [
  'upd',
  'request',
  'transport_waybill',
  'os2_transfer',
]);
export const sourceOriginEnum = pgEnum('source_origin', [
  'edo_diadoc',
  'manual_xml',
  'manual_pdf',
  'mail',
]);
export const sourceStatusEnum = pgEnum('source_status', [
  'parsed',
  'parse_failed',
  'archived',
  'queued',
  'processing',
  'needs_resolution',
]);
export const sourceDirectionEnum = pgEnum('source_direction', ['inbound', 'outbound']);
export const photoKindEnum = pgEnum('photo_kind', ['document', 'cargo', 'vehicle', 'other']);
// Этап приёмки: 'before' — фото 1-го этапа (на КПП), 'after' — фото 2-го
// этапа (после выгрузки/подтверждения МОЛ). Только для delivery_photos.
export const deliveryPhotoStageEnum = pgEnum('delivery_photo_stage', ['before', 'after']);
// Этап у фото отгрузки — зеркало deliveryPhotoStageEnum. Введён миграцией
// 0048, чтобы Принятые на портале показывали «1 Этап (N) / 2 Этап (M)»
// как у приёмок.
export const shipmentPhotoStageEnum = pgEnum('shipment_photo_stage', ['before', 'after']);
export const llmKindEnum = pgEnum('llm_kind', [
  'openrouter',
  'google_ai_studio',
  'qwen_self_hosted',
  'vertex',
]);
export const attachmentRoleEnum = pgEnum('attachment_role', ['original', 'extracted_text']);

// ─── Кэш распознавания позиций фото-документа ─────────────────────────────
// См. миграцию 0058. Фото живёт либо в delivery_photos, либо в shipment_photos
// (polymorphic), CHECK гарантирует ровно один FK. UI в split-view модалке
// читает items для правой панели; LLM-вызов из routes/photos.ts.
// Объявление будет ниже после deliveryPhotos/shipmentPhotos.

// ─── Statuses (универсальный справочник статусов для разных сущностей) ────

export const statuses = pgTable(
  'statuses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    label: varchar('label', { length: 128 }).notNull(),
    color: varchar('color', { length: 32 }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('statuses_entity_code_unique').on(t.entityType, t.code)],
);

// ─── Auth ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('manager'),
    isActive: boolean('is_active').notNull().default(false),
    // ФИО для отображения в шапке/футере и в админке. Опциональное:
    // существующие users без значения, новые могут указать на регистрации
    // или позже через «Личный кабинет».
    fullName: text('full_name'),
    // Контактный телефон (для роли manager — нужен мобильному клиенту
    // КПП, чтобы инспектор мог позвонить менеджеру, который загрузил УПД).
    // Опциональный для всех ролей; нормализация формата на стороне клиента.
    phone: varchar('phone', { length: 32 }),
    // Объект, к которому привязан пользователь. Обязателен для inspector_kpp
    // (определяет область видимости приёмок/отгрузок/документов).
    // Для admin/manager всегда null.
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    // Подрядчик, к которому привязан пользователь. Обязателен для роли
    // contractor (определяет область видимости: только свои приёмки/отгрузки/
    // документы по всем объектам). Для остальных ролей всегда null. Ссылается на
    // справочник заказчика customer_counterparties; в рантайме разворачивается в
    // операционные counterparties по ИНН (см. lib/contractor-scope.ts).
    contractorCustomerId: uuid('contractor_customer_id').references(
      () => customerCounterparties.id,
      { onDelete: 'set null' },
    ),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionsInvalidatedAt: timestamp('sessions_invalidated_at', { withTimezone: true }),
    // Длина текущей серии неверных паролей. Единственное её назначение —
    // нарастающая пауза перед ответом (см. backoffSleep в routes/auth.ts).
    // Вход аккаунт НЕ блокирует: верный пароль пускает всегда.
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    // Время последней неудачи. Серия «протухает» после часа без единой
    // ошибки — тогда счётчик начинается заново. Без этой отметки счётчик
    // копился месяцами и складывал ошибки, разделённые неделями.
    lastFailedLoginAt: timestamp('last_failed_login_at', { withTimezone: true }),
    // Историческая блокировка аккаунта на 30 минут после 10 неудач. Больше не
    // выставляется никогда (требование: верные логин и пароль пускают всегда).
    // Колонка оставлена, чтобы не гонять миграцию ради удаления; её продолжает
    // обнулять админский сброс пароля.
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_site_idx').on(t.siteId).where(sql`${t.siteId} is not null`),
    index('users_contractor_customer_idx')
      .on(t.contractorCustomerId)
      .where(sql`${t.contractorCustomerId} is not null`),
  ],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenIp: varchar('last_seen_ip', { length: 64 }),
  lastSeenUa: text('last_seen_ua'),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('refresh_token_hash_unique').on(t.tokenHash),
    // revokeBySessionId гасит все живые токены сессии по session_id, а таблица
    // растёт на каждую ротацию (на проде — сотни тысяч строк / десятки МБ), и
    // без индекса каждый logout и каждая инвалидация сканировали её целиком.
    // Частичный: отозванные строки в этот запрос не попадают никогда.
    index('refresh_tokens_session_active_idx')
      .on(t.sessionId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// ─── Сброс пароля: заявка и ссылка — РАЗНЫЕ сущности ──────────────────────
//
// Заявка создаётся публичной формой «Забыли пароль?» и ничего секретного не
// содержит: она лишь поднимает в админке флаг «человек просит сброс».
// Ссылку выпускает администратор отдельным действием.
//
// Почему не одна таблица. Если бы публичная форма выпускала токен сама, любой
// знающий чужой email бесконечно обнулял бы уже отправленную человеку ссылку —
// достаточно дёргать форму. Разделение делает это невозможным физически.
export const passwordResetRequests = pgTable(
  'password_reset_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Заявка закрывается либо администратором (кнопкой или выдачей ссылки),
    // либо сама при следующем обычном входе — иначе тег «Запросил сброс»
    // висел бы вечно у того, кто просто вспомнил пароль.
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    // Одна открытая заявка на пользователя: повторное нажатие обновляет дату.
    uniqueIndex('password_reset_requests_open_unique')
      .on(t.userId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

// Ссылка на смену пароля. Токен равносилен паролю — им захватывают аккаунт,
// поэтому, в отличие от share_tokens, открытым он НЕ хранится: для поиска
// лежит sha256, для повторного показа администратору — AES-256-GCM-конверт
// (buildAad('password_reset_tokens', id), id генерируется до шифрования).
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenEncrypted: text('token_encrypted').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_hash_unique').on(t.tokenHash),
    // Не более одной НЕПОГАШЕННОЙ ссылки на пользователя. Предикат намеренно
    // без `expires_at > now()`: индексное выражение обязано быть immutable, с
    // now() миграция не применится вовсе. Плата — выдавая новую ссылку, надо
    // отзывать все неиспользованные, включая протухшие.
    uniqueIndex('password_reset_tokens_one_open')
      .on(t.userId)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
  ],
);

export const authEvents = pgTable(
  'auth_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    emailHash: varchar('email_hash', { length: 64 }),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
    event: varchar('event', { length: 64 }).notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  },
  (t) => [
    index('auth_events_user_ts_idx').on(t.userId, t.ts),
    index('auth_events_event_ts_idx').on(t.event, t.ts),
  ],
);

export const unauthorizedAccessLog = pgTable('unauthorized_access_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  statusCode: integer('status_code').notNull(),
  method: varchar('method', { length: 8 }).notNull(),
  path: text('path').notNull(),
  ip: varchar('ip', { length: 64 }),
  userAgent: text('user_agent'),
  errorMessage: text('error_message'),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Матрица прав ролей: «роль × страница × действие».
 *
 * Строка здесь — OVERRIDE, то есть отклонение от дефолта. Её отсутствие
 * означает «как в коде» (DEFAULT_MATRIX из @matcheck/contracts), а не
 * «запрещено» — поэтому таблица создаётся пустой и «Сбросить к дефолту»
 * означает DELETE строк, а не запись сегодняшних значений.
 *
 * Роли admin в таблице нет и быть не может (CHECK): она обходит матрицу
 * целиком, иначе админ способен запереть себя вне вкладки «Роли».
 *
 * page_id — без FK и без таблицы-каталога: каталог страниц живёт в коде и
 * меняется вместе с релизом (см. 0092_role_permissions.sql).
 *
 * ИНВАРИАНТ СОПРОВОЖДЕНИЯ. Строка хранит снимок всех четырёх действий, а не
 * только изменённое. Матрица умеет расширять права, и «расширение» вычисляется
 * как «в DEFAULT_MATRIX false, а в строке true». Поэтому СУЖЕНИЕ base в коде
 * (действие было у роли по умолчанию, стало не быть) превращает уже
 * сохранённые true в расширения, которых администратор не выдавал: он этой
 * ячейки мог вообще не касаться.
 *
 * Любое такое изменение base обязано сопровождаться нормализующей миграцией —
 * обнулить в строках значения, совпадавшие со старым дефолтом, — либо
 * переходом на поячеечное хранение overrides.
 */
export const rolePagePermissions = pgTable(
  'role_page_permissions',
  {
    role: userRoleEnum('role').notNull(),
    pageId: varchar('page_id', { length: 64 }).notNull(),
    canView: boolean('can_view').notNull().default(false),
    canCreate: boolean('can_create').notNull().default(false),
    canEdit: boolean('can_edit').notNull().default(false),
    canDelete: boolean('can_delete').notNull().default(false),
    // Отметка проверки качества на Операциях. Отдельное действие, а не часть
    // canEdit: ячейкой edit помечены маршруты с разными allow-list, и пока
    // отметка сидела внутри неё, у monitor'а право было базовым — то есть
    // никогда не считалось расширением и не открывало настоящую правку.
    canReview: boolean('can_review').notNull().default(false),
    // Повторное распознавание документа. Тоже отдельное действие: правка полей
    // и повторный прогон через модель различаются и по цене, и по последствиям.
    canReparse: boolean('can_reparse').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    primaryKey({ name: 'role_page_permissions_pkey', columns: [t.role, t.pageId] }),
    check('role_page_permissions_no_admin', sql`${t.role} <> 'admin'`),
  ],
);

// ─── Counterparties / Materials ─────────────────────────────────────────────

export const counterparties = pgTable(
  'counterparties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inn: varchar('inn', { length: 12 }).notNull(),
    kpp: varchar('kpp', { length: 9 }),
    name: text('name').notNull(),
    // Альтернативные написания для дедупа при «+ Создать» из combobox.
    // Поиск в API counterparties идёт по lower(name) или lower(any(aliases)).
    // Редактируется админом в Справочниках.
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    address: text('address'),
    isSelf: boolean('is_self').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isCustomer: boolean('is_customer').notNull().default(false),
    isContractor: boolean('is_contractor').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('counterparty_inn_kpp_unique')
      .on(t.inn, t.kpp)
      .where(sql`${t.kpp} is not null`),
    uniqueIndex('counterparty_inn_unique')
      .on(t.inn)
      .where(sql`${t.kpp} is null`),
    index('counterparty_supplier_idx')
      .on(t.name)
      .where(sql`${t.isSupplier}`),
    index('counterparty_contractor_idx')
      .on(t.name)
      .where(sql`${t.isContractor}`),
  ],
);

export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 64 }),
    name: text('name').notNull(),
    unit: varchar('unit', { length: 16 }).notNull().default('шт'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('material_code_unique')
      .on(t.code)
      .where(sql`${t.code} is not null`),
    index('material_name_idx').on(t.name),
  ],
);

// ─── Справочники заказчика (импорт из JSON, миграция 0055) ──────────────────
// ВАЖНО: это ОТДЕЛЬНЫЕ таблицы, НЕ операционная `counterparties`. Боевая
// `counterparties` завязана на FK приёмок/отгрузок и sync мобильного клиента,
// поэтому её НЕ трогаем. Сюда импортируется справочник заказчика (СУ-10):
// данные могут быть «грязными» (ИНН с запятыми, пробелами, кириллицей,
// 11-значные) — поэтому `inn` здесь text без строгих констрейнтов и без
// unique. Редактируется в Справочниках (CRUD). На приёмки/отгрузки/мобилу
// эти таблицы не влияют. id сохраняются из источника (идемпотентный re-seed).

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inn: text('inn').notNull().default(''),
    name: text('name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Статус проверки службой безопасности заказчика: approved | rejected | null.
    lastSecurityStatus: varchar('last_security_status', { length: 32 }),
    foundingDocumentsComment: text('founding_documents_comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('supplier_name_idx').on(t.name)],
);

export const customerCounterparties = pgTable(
  'customer_counterparties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inn: text('inn').notNull().default(''),
    name: text('name').notNull(),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    address: text('address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('customer_counterparty_name_idx').on(t.name)],
);

// ─── Справочник МОЛ (материально-ответственные лица собственных бригад) ────
// См. миграцию 0027. Параллелен counterparties с ролью contractor:
// получатели материалов и ОС, на которых оформляется документ. Не путать
// с deliveries.confirmed_by_mol_user_id (там — пользователь системы).

export const responsiblePersons = pgTable(
  'responsible_persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    position: text('position'),
    isActive: boolean('is_active').notNull().default(true),
    // Если NOT NULL — запись пришла из внешней БД ФОТ (см. routes/mol.ts
    // и domain/mol/syncFotMol.ts). Локально созданные МОЛ имеют NULL —
    // они редактируются через UI; ФОТ-записи read-only и обновляются
    // через UPSERT по этому полю. Уникальность гарантирует partial unique
    // index (миграция 0053).
    fotEmployeeId: bigint('fot_employee_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('responsible_persons_active_name_idx')
      .on(t.fullName)
      .where(sql`${t.isActive}`),
  ],
);

// ─── Справочник ОС (основных средств) ─────────────────────────────────────
// См. миграцию 0028. Используется в позициях документов через item_kind='asset'
// (миграция 0029). Один экземпляр ОС в строке документа дополнительно
// характеризуется inventory_number / serial_number.

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 64 }),
    name: text('name').notNull(),
    unit: varchar('unit', { length: 16 }).notNull().default('шт'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_code_unique')
      .on(t.code)
      .where(sql`${t.code} is not null`),
    index('asset_active_name_idx')
      .on(t.name)
      .where(sql`${t.isActive}`),
  ],
);

// ─── Sites (объекты строительства) ─────────────────────────────────────────

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Было varchar(5); расширено до 16 миграцией 0054, чтобы вместить
    // ФОТ-коды длиннее 5 символов (ПРИМ22 и т.п.).
    code: varchar('code', { length: 16 }).notNull(),
    name: text('name').notNull(),
    fullName: text('full_name'),
    address: text('address'),
    isActive: boolean('is_active').notNull().default(true),
    // Если NOT NULL — запись пришла из внешнего источника (JSON-сид от
    // заказчика). По нему мы UPSERT-аем при будущих обновлениях файла;
    // через UI у таких объектов доступны только смена активности и просмотр
    // (справочные поля и DELETE защищены fot_readonly — см. routes/sites.ts).
    // Локально созданные объекты имеют NULL и редактируются как раньше.
    // Уникальность — partial unique index из миграции 0054.
    fotSiteId: bigint('fot_site_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('site_code_unique').on(t.code),
    index('site_active_idx')
      .on(t.name)
      .where(sql`${t.isActive}`),
  ],
);

/**
 * Системный объект «Без объекта» — используется как заглушка при миграции
 * существующих приёмок и должен оставаться is_active=false.
 */
export const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Справочник единиц измерения для UI-выпадайки. См. миграцию 0062.
 * Сами позиции (delivery_items/shipment_items/source_document_items) хранят
 * unit как text БЕЗ FK на этот справочник — нельзя ломать legacy-данные
 * и мобильный клиент.
 */
export const units = pgTable(
  'units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    // Код по ОКЕИ — для справки / будущей сверки с УПД (LLM иногда
    // возвращает ОКЕИ-код вместо текста). Nullable: для нестандартных
    // единиц («бухта», «мешок») кода в ОКЕИ может не быть.
    okeiCode: varchar('okei_code', { length: 8 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('units_code_unique').on(sql`lower(${t.code})`),
    index('units_active_idx').on(t.isActive),
  ],
);

// ─── ЭДО / Mail / LLM accounts ─────────────────────────────────────────────

export const edoAccounts = pgTable('edo_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: varchar('provider', { length: 32 }).notNull().default('diadoc'),
  name: text('name').notNull(),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mailAccounts = pgTable('mail_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull().default(993),
  useTls: boolean('use_tls').notNull().default(true),
  username: text('username').notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  folder: text('folder').notNull().default('INBOX'),
  // IMAP UID доходит до 2^32-1 — int4 переполняется.
  lastUid: bigint('last_uid', { mode: 'number' }),
  // Смена UIDVALIDITY означает, что прежние UID больше не действительны и
  // watermark надо сбрасывать, иначе письма пропускаются или дублируются.
  uidValidity: bigint('uid_validity', { mode: 'number' }),
  isActive: boolean('is_active').notNull().default(true),
  // 'request' — исторический ящик заявок (письмо сразу разбирается LLM);
  // 'document' — ящик подрядчиков, письма попадают в карантин и ждут оператора.
  purpose: text('purpose').notNull().default('request'),
  // Поллинг включается ОТДЕЛЬНО от is_active: ящик можно завести и проверить
  // до того, как его начнёт опрашивать воркер.
  pollEnabled: boolean('poll_enabled').notNull().default(false),
  // Лиз с владельцем и токеном: снять или продлить может только тот экземпляр
  // воркера, который его взял, поэтому перезапущенный процесс не отбирает лиз
  // у живого.
  pollLeaseOwner: uuid('poll_lease_owner'),
  pollLeaseToken: uuid('poll_lease_token'),
  pollLeaseUntil: timestamp('poll_lease_until', { withTimezone: true }),
  // Предзаполнение карточки разбора, если для письма не нашлось правила.
  defaultSiteId: uuid('default_site_id').references(() => sites.id, { onDelete: 'set null' }),
  defaultDirection: sourceDirectionEnum('default_direction'),
  defaultContractorId: uuid('default_contractor_id').references(() => counterparties.id, {
    onDelete: 'set null',
  }),
  // Антишумовой фильтр отправителей, НЕ подтверждение личности: From
  // подделывается, поэтому автообработка по нему одному невозможна.
  senderAllowlist: text('sender_allowlist').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmProviders = pgTable('llm_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: llmKindEnum('kind').notNull(),
  // Legacy: до 0020 ключ и base URL хранились здесь, теперь — в llm_provider_credentials по kind.
  // Колонки оставлены NULLABLE как страховка; следующей миграцией DROP.
  apiBaseUrl: text('api_base_url'),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  temperature: numeric('temperature', { precision: 4, scale: 2 }).notNull().default('0.2'),
  maxTokens: integer('max_tokens').notNull().default(16384),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmProviderCredentials = pgTable('llm_provider_credentials', {
  kind: llmKindEnum('kind').primaryKey(),
  apiBaseUrl: text('api_base_url').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docKind: text('doc_kind').notNull(),
    name: text('name').notNull(),
    content: text('content').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('prompts_active_per_kind')
      .on(t.docKind)
      .where(sql`${t.isActive} = true`),
    index('prompts_doc_kind_idx').on(t.docKind),
  ],
);

// ─── Source documents (UPD + Requests) ─────────────────────────────────────

export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: sourceKindEnum('kind').notNull(),
    direction: sourceDirectionEnum('direction').notNull().default('inbound'),
    status: sourceStatusEnum('status').notNull().default('parsed'),
    supplierId: uuid('supplier_id').references(() => counterparties.id, { onDelete: 'set null' }),
    // Связь со справочником поставщиков (suppliers, 982+ записей, импорт из
    // JSON заказчика). Для новых распознанных УПД пишем СЮДА, а supplier_id
    // (на counterparties) оставляем NULL — поставщики ≠ контрагенты. Для
    // исторических УПД эта колонка NULL, supplier_id заполнен по-старому.
    // DTO supplierName собирает имя через COALESCE(suppliers.name, counterparties.name).
    // См. миграцию 0064_supplier_directory_link.
    supplierDirectoryId: uuid('supplier_directory_id').references(() => suppliers.id, {
      onDelete: 'set null',
    }),
    recipientId: uuid('recipient_id').references(() => counterparties.id, { onDelete: 'set null' }),
    contractorId: uuid('contractor_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    recipientMolId: uuid('recipient_mol_id').references(() => responsiblePersons.id, {
      onDelete: 'set null',
    }),
    // Кто проставил получателя (contractor_id либо МОЛ) у inbound-документа:
    //   null         — не задавали ни человек, ни автоматика;
    //   'manual'     — человек: подрядчик, МОЛ или явная очистка поля;
    //   'auto_buyer' — резолвер по ИНН покупателя из графы 6.
    //
    // Нужно, чтобы второй проход распознавания не возвращал подрядчика, которого
    // менеджер сознательно очистил: одного «contractor_id is null» для этого не
    // хватает. RBAC роли contractor значение 'auto_buyer' НЕ признаёт —
    // содержимое публично загруженного файла недоверенное, см. lib/contractor-scope.ts.
    // Только для direction='inbound'; см. миграцию 0088.
    recipientSource: text('recipient_source').$type<'manual' | 'auto_buyer'>(),
    // ─── Стороны САМОГО документа (распознаются), а не операционные получатели ───
    //
    // recipient_id и contractor_id выбирает человек: первый — получатель
    // отгрузки, второй — подрядчик на объекте, и на нём висят права роли
    // contractor, ключ идемпотентности пакета и путь в S3. Покупатель и
    // грузополучатель из шапки УПД — совсем другая сущность, поэтому у них
    // свои колонки.
    //
    // *_name_raw — источник истины, а FK лишь нормализация: графу 4 печатают
    // без ИНН («Грузополучатель и его адрес ООО "СУ-10", Россия, …»), а
    // counterparties.inn NOT NULL — связать такую сторону не с чем.
    buyerId: uuid('buyer_id').references(() => counterparties.id, { onDelete: 'set null' }),
    buyerNameRaw: text('buyer_name_raw'),
    consigneeId: uuid('consignee_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    consigneeNameRaw: text('consignee_name_raw'),
    // ИНН сторон — как напечатан в документе. Показываем его в списке под
    // названием стороны; справочник (suppliers.inn / counterparties.inn по FK)
    // остаётся запасным путём для документов, распознанных до миграции 0095.
    //
    // Поставщик здесь тоже нужен, хотя FK на suppliers почти всегда заполнен:
    // справочную запись правят люди, а это поле отвечает на другой вопрос —
    // что стояло в документе. По той же причине ручная правка поставщика в
    // карточке обнуляет supplier_inn_raw, а не пишет туда введённое значение.
    //
    // text без CHECK: в документах попадаются ИНН с пробелами, 11 знаков и
    // подписью «ИНН …». Нормализует код (normalizeInn), БД не отбраковывает —
    // иначе распознанный документ терялся бы целиком.
    supplierInnRaw: text('supplier_inn_raw'),
    buyerInnRaw: text('buyer_inn_raw'),
    consigneeInnRaw: text('consignee_inn_raw'),
    // Состояние второго прохода распознавания (текст → картинка).
    //
    // Отдельная колонка, а НЕ parse_error_details: те перезаписываются целиком
    // в конце каждого разбора и при успехе становятся null — маркер «повтор уже
    // заказан» там бы не пережил собственный успешный проход, и документ гонял
    // бы задания по кругу.
    //
    // { state: 'queued'|'done', requestedAt, mode: 'vision',
    //   outcome?: 'replaced'|'kept_baseline'|'vision_failed', error?: string }
    secondPass: jsonb('second_pass'),
    // Состояние РУЧНОГО повторного распознавания (кнопка «Распознать повторно»)
    // вместе со снимком того, что было до попытки.
    //
    // Снимок здесь не для истории, а для отката: неудачный повтор обязан вернуть
    // документ в прежний вид целиком, а маршрут к этому моменту уже сменил
    // статус и обнулил second_pass. Хранить снимок в parse_error_details нельзя
    // по той же причине, по которой там не живёт second_pass, — они
    // перезаписываются каждым разбором.
    //
    // { state: 'queued'|'processing'|'succeeded'|'failed', generation, at, by,
    //   reason?, snapshot: { status, parseErrorCode, parseErrorDetails,
    //   validation, processedAt, secondPass } }
    reparse: jsonb('reparse').$type<Record<string, unknown> | null>(),
    // Чем документ был разобран в последний раз (ParseMode из worker.ts).
    // Нужен повтору: он обязан пойти ТЕМ ЖЕ путём, иначе М-15 уедет на
    // УПД-промпт, а логический УПД из комплекта фото — на разбор всего файла.
    parseMode: text('parse_mode'),
    // Позиция документа в пакете накладных (индекс в parsed.documents у
    // parseWaybillBatch). Постоянная привязка результата повтора к строке:
    // сопоставление по номеру не годится там, где номер и распознан неверно —
    // ровно в том случае, ради которого повтор и запускают.
    batchIndex: integer('batch_index'),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    docNumber: text('doc_number'),
    docDate: timestamp('doc_date', { withTimezone: false, mode: 'date' }),
    totalSum: numeric('total_sum', { precision: 18, scale: 2 }),
    vatSum: numeric('vat_sum', { precision: 18, scale: 2 }),
    expectedDate: timestamp('expected_date', { withTimezone: false, mode: 'date' }),
    origin: sourceOriginEnum('origin').notNull(),
    edoAccountId: uuid('edo_account_id').references(() => edoAccounts.id, { onDelete: 'set null' }),
    providerMessageId: text('provider_message_id'),
    mailAccountId: uuid('mail_account_id').references(() => mailAccounts.id, {
      onDelete: 'set null',
    }),
    messageId: text('message_id'),
    messageReceivedAt: timestamp('message_received_at', { withTimezone: true }),
    llmProviderId: uuid('llm_provider_id').references(() => llmProviders.id, {
      onDelete: 'set null',
    }),
    llmConfidence: numeric('llm_confidence', { precision: 4, scale: 3 }),
    parsedAt: timestamp('parsed_at', { withTimezone: true }).notNull().defaultNow(),
    parseError: text('parse_error'),
    parseErrorCode: text('parse_error_code'),
    parseErrorDetails: jsonb('parse_error_details').$type<Record<string, unknown> | null>(),
    jobId: text('job_id'),
    jobAttempts: integer('job_attempts').notNull().default(0),
    contentHash: varchar('content_hash', { length: 64 }),
    originalFilename: text('original_filename'),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    validation: jsonb('validation').$type<UpdValidation | null>(),
    // Пользователь, загрузивший УПД через /upload-upd или /upload-upd-pdf.
    // Для EDO/mail-полученных документов — NULL (poller, не юзер).
    // Используется мобильным клиентом для отображения контакта менеджера
    // в шапке списка материалов на 1 Этапе приёмки.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    // Техническая запись пакета: создаётся при загрузке, живёт до разбора и
    // удаляется воркером. Флаг, а не эвристика «kind + наличие bundle»: у
    // реальных ТН тот же kind. Такие записи исключаются из /sync, списка и
    // экспорта — иначе они уезжают на планшет и висят там фантомом.
    isTechnical: boolean('is_technical').notNull().default(false),
    dispatchGeneration: integer('dispatch_generation').notNull().default(0),
    // Ссылка на пакет загрузки (см. sourceBundles). Один пакет может породить
    // N source_documents — например ТН-2116 + ОС-2 из одной пачки фото.
    bundleId: uuid('bundle_id').references((): AnyPgColumn => sourceBundles.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('source_edo_message_unique')
      .on(t.edoAccountId, t.providerMessageId)
      .where(sql`${t.edoAccountId} is not null`),
    uniqueIndex('source_mail_message_unique')
      .on(t.mailAccountId, t.messageId)
      .where(sql`${t.mailAccountId} is not null`),
    index('source_kind_doc_date_idx')
      .on(t.docDate)
      .where(sql`${t.kind} = 'upd'`),
    index('source_kind_expected_date_idx')
      .on(t.expectedDate)
      .where(sql`${t.kind} = 'request'`),
    index('source_direction_idx').on(t.direction),
    index('source_upd_dedup_idx')
      .on(t.supplierId, t.docNumber, t.docDate)
      .where(
        sql`${t.kind} = 'upd' and ${t.supplierId} is not null and ${t.docNumber} is not null and ${t.docDate} is not null`,
      ),
    // Параллельный дедуп-индекс для УПД, ссылающихся на справочник suppliers
    // (новый путь распознавания после 0064). Существующий source_upd_dedup_idx
    // остаётся работать для исторических УПД, привязанных к counterparties.
    index('source_upd_dedup_directory_idx')
      .on(t.supplierDirectoryId, t.docNumber, t.docDate)
      .where(
        sql`${t.kind} = 'upd' and ${t.supplierDirectoryId} is not null and ${t.docNumber} is not null and ${t.docDate} is not null`,
      ),
    index('source_contractor_idx')
      .on(t.contractorId)
      .where(sql`${t.contractorId} is not null`),
    index('source_site_idx').on(t.siteId).where(sql`${t.siteId} is not null`),
    index('source_documents_created_by_idx')
      .on(t.createdByUserId)
      .where(sql`${t.createdByUserId} is not null`),
    index('source_documents_content_hash_idx')
      .on(t.contractorId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    index('source_documents_unfinished_idx')
      .on(t.status, t.parsedAt)
      .where(sql`${t.status} in ('queued', 'processing')`),
    index('source_documents_bundle_idx')
      .on(t.bundleId)
      .where(sql`${t.bundleId} is not null`),
    // Готовность УПД к приёмке стережёт код (domain/edo/upd-outcome.ts), а не
    // база: там же проверяется полнота списка позиций, которую CHECK выразить
    // не может. Базе остаётся единственный реквизит, без которого документ не
    // опознать, — номер. Дата и сумма необязательны с миграции 0107: на
    // фотографии шапочная сумма часто не пропечатана, а подставлять вместо
    // даты документа дату поставки нельзя.
    check(
      'source_upd_required',
      sql`(${t.kind} <> 'upd') or (${t.status} <> 'parsed') or (${t.docNumber} is not null)`,
    ),
  ],
);

// Пакет файлов одной загрузки накладных. Один пакет может породить N
// source_documents разных форм (ТН-2116 + ОС-2 в одной пачке фото).
// Уникальность по bundle_hash обеспечивает идемпотентность при
// повторной загрузке того же набора файлов.
export const sourceBundles = pgTable(
  'source_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleHash: varchar('bundle_hash', { length: 64 }).notNull(),
    // Хеш только от байтов файлов (то же, что bundle_hash) — вынесен отдельно,
    // потому что bundle_hash уходит вместе со старым unique.
    contentHash: varchar('content_hash', { length: 64 }),
    // Ключ идемпотентности СО SCOPE: объект, направление, получатель, дата
    // плюс content_hash. Уникальность по одному лишь bundle_hash склеивает тот
    // же УПД, загруженный на разные объекты, и молча возвращает чужой пакет.
    // NOT NULL + UNIQUE навешивает contract-миграция, после перевода writers.
    idempotencyKey: text('idempotency_key'),
    origin: sourceOriginEnum('origin'),
    // Sub-пакет накладной ссылается на родительский.
    parentBundleId: uuid('parent_bundle_id').references((): AnyPgColumn => sourceBundles.id, {
      onDelete: 'set null',
    }),
    // Счётчик НАМЕРЕННЫХ запусков разбора: входит в dispatch ID, поэтому
    // повторный разбор получает новый jobId и реально выполняется.
    dispatchGeneration: integer('dispatch_generation').notNull().default(0),
    // Счётчик попыток ЗАГРУЗКИ (не разбора). Инкрементируется при приёме и при
    // takeover брошенной попытки; блокировка строки пакета сериализует
    // конкурентов, поэтому отдельный счётчик не нужен. Текущее значение — то,
    // которое считается «живым»: строки реестра и попытки с меньшим поколением
    // относятся к брошенным загрузкам и в разбор не идут.
    activeUploadGeneration: integer('active_upload_generation').notNull().default(0),
    direction: sourceDirectionEnum('direction').notNull(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    contractorId: uuid('contractor_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    recipientMolId: uuid('recipient_mol_id').references(() => responsiblePersons.id, {
      onDelete: 'set null',
    }),
    expectedDate: timestamp('expected_date', { mode: 'date' }),
    // queued | processing | parsed | parse_failed
    status: text('status').notNull().default('queued'),
    parseErrorCode: text('parse_error_code'),
    parseErrorMessage: text('parse_error_message'),
    docCount: integer('doc_count').notNull().default(0),
    // Тип пакета: 'upd' | 'waybill' | 'mixed'. Для нового единого входа
    // (/upload-documents) ставится 'mixed'; старые waybill-bundle создавались
    // до router'а и имеют NULL. Основной дискриминатор маршрута в worker — это
    // job.data.mode, kind здесь резервный признак для отчётности/диагностики.
    kind: text('kind'),
    // Как собран пакет (см. миграцию 0096):
    //   legacy     — «файл = документ», группировать нельзя;
    //   logical_v1 — «логический УПД = документ», группа = корневой пакет.
    // Уже загруженные пакеты остаются legacy навсегда: внутри них страницы
    // одной УПД лежат отдельными документами, и показ их одной поставкой
    // задвоил бы материалы.
    assemblyVersion: text('assembly_version').notNull().default('legacy'),
    // Поколение, которое РАЗРЕШЕНО показывать. Выставляется той же транзакцией,
    // что публикует собранный набор. NULL — публиковать нечего: legacy-пакет
    // либо сборка не завершилась, и промежуточные документы наружу не идут.
    publishedGeneration: integer('published_generation'),
    // Версия состава группы: растёт и при изменении набора документов, и при
    // изменении реквизитов/позиций любого из них. Планшет сверяет её при
    // создании приёмки — «состав тот же, но суммы другие» тоже расхождение.
    groupRevision: integer('group_revision').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('source_bundles_bundle_hash_unique').on(t.bundleHash),
    // Канонический ключ пакета. Частичный: пакеты накладных и строки,
    // созданные до перевода writers, живут с NULL и под уникальность не идут.
    uniqueIndex('source_bundles_idempotency_key_unique')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // Поиск пакета-двойника: та же пачка файлов в другом scope. Нужен ради
    // пометки менеджеру, переиспользование идёт по ключу выше.
    index('source_bundles_content_hash_idx')
      .on(t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    index('source_bundles_parent_idx')
      .on(t.parentBundleId)
      .where(sql`${t.parentBundleId} is not null`),
  ],
);

// Попытка ЗАГРУЗКИ пакета: uploading → accepted | abandoned.
//
// Между резервированием пакета и финальной транзакцией лежит заливка в S3.
// Без явного состояния попытки это окно неразличимо снаружи: пакет в queued
// может означать и «файлы ещё летят», и «процесс умер на середине». Первое
// нельзя трогать, второе нужно вычистить — отсюда lease владельца.
//
// lease_until нужен и для fencing: медленная попытка, потерявшая владение,
// не имеет права завершиться успехом, поэтому финальная транзакция проверяет
// generation = source_bundles.active_upload_generation.
export const bundleUploadAttempts = pgTable(
  'bundle_upload_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => sourceBundles.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    // uploading | accepted | abandoned
    state: text('state').notNull().default('uploading'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bundle_upload_attempts_generation_unique').on(t.bundleId, t.generation),
    // Sweeper ищет только просроченные незавершённые попытки.
    index('bundle_upload_attempts_stale_idx')
      .on(t.leaseUntil)
      .where(sql`${t.state} = 'uploading'`),
  ],
);

// Реестр входных файлов пачки: одна ПОСТОЯННАЯ строка на КАЖДЫЙ принятый файл —
// что классификатор определил, каким парсером обработали, что создали и чем всё
// закончилось. Аудит, источник страницы результата импорта и единственное
// место, по которому можно сверить «всё принятое дошло до результата».
//
// Раньше это был журнал одного прогона: router очищал его перед каждым разбором,
// а перечень файлов жил в attachments служебной записи, которая удаляется в
// конце. Файл, упавший при разборе, не оставлял следов вообще. Теперь строка
// заводится при приёме и переживает и разбор, и удаление служебной записи.
//
// Принцип «не пишем наугад» сохраняется: неуверенные файлы остаются со
// status='needs_review' и НЕ создают source_documents.
export const bundleImportItems = pgTable(
  'bundle_import_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => sourceBundles.id, { onDelete: 'cascade' }),
    sourceFilename: text('source_filename').notNull(),
    // Ключ объекта в S3 — идентификатор входного файла, по которому идёт upsert
    // и повторный прогон отличает уже обработанное. NOT NULL навесит
    // contract-миграция: у legacy-строк ключа нет и восстановить его неоткуда.
    inputS3Key: text('input_s3_key'),
    mimeType: varchar('mime_type', { length: 255 }),
    sizeBytes: integer('size_bytes'),
    // SHA-256 содержимого (hex). Отвечает на вопрос, на который хеш пачки
    // ответить не может: какой из присланных СЕЙЧАС файлов соответствует вон
    // той строке реестра. Нужно при дозагрузке пакета, часть файлов которого не
    // дошла до S3: имена у поставщиков повторяются, порядок человек меняет, а
    // содержимое различает однозначно. NULL у строк до миграции 0106.
    contentSha256: text('content_sha256'),
    // Поколение попытки загрузки: строки прошлых поколений относятся к
    // брошенным загрузкам и в разбор не идут.
    uploadGeneration: integer('upload_generation'),
    // Порядок файла внутри пачки (0-based). Без него набор фотографий нельзя
    // разложить в страницы: «вторая страница» определяется соседством с
    // первой, а выборка из реестра порядка не гарантирует. NULL у строк,
    // созданных до миграции 0096.
    inputOrder: integer('input_order'),
    // Что собирались делать с файлом, известно уже при приёме:
    //   auto       — классифицировать и распознать, если тип подтверждён;
    //   store_only — файл из зоны «Дополнительные документы»: только сохранить.
    // Отвечает на другой вопрос, чем status («чем кончилось»), поэтому колонка
    // отдельная: у skipped иначе неразличимы «человек сказал не распознавать» и
    // «тип определить не удалось».
    processingMode: text('processing_mode').notNull().default('auto'),
    // upd | transport_waybill | os2_transfer | m15 | supplementary | unknown
    detectedKind: text('detected_kind'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    // parseUpdXlsx | parseUpdPdf | tryParseTextUpdBundle | parseWaybillBatch | none
    parserUsed: text('parser_used'),
    // uploading | accepted | created | needs_review | skipped | failed
    status: text('status').notNull().default('needs_review'),
    reason: text('reason'),
    // ID созданных source_documents (обычно 0 или 1; multi-UPD → один агрегат)
    createdDocumentIds: jsonb('created_document_ids').$type<string[]>().notNull().default([]),
    // Накладная разворачивается в ДОЧЕРНИЙ пакет, поэтому у итогового документа
    // bundle_id уже не родительский — связь на sub-пакет нужна явная.
    subBundleId: uuid('sub_bundle_id').references((): AnyPgColumn => sourceBundles.id, {
      onDelete: 'set null',
    }),
    // КОНЕЧНОЕ состояние файла, а не решение router'а: status='created' значит
    // лишь «дочернее задание поставлено», документ после этого ещё может уйти в
    // parse_failed. Счётчики и «Требует внимания» смотрят сюда.
    effectiveStatus: text('effective_status'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Документ, заведённый менеджером вручную по этому файлу.
    manualDocumentId: uuid('manual_document_id').references((): AnyPgColumn => sourceDocuments.id, {
      onDelete: 'set null',
    }),
    // Документ, заведённый по этому файлу автоматически, — в том числе
    // заглушка для файла, из которого распознавания не вышло.
    //
    // Дублирует created_document_ids намеренно: тот jsonb без FK, и после
    // удаления документа продолжает указывать в пустоту. Проверять по нему
    // «документ уже есть» нельзя, а здесь БД сама обнулит ссылку. Пара
    // (stub_document_id, resolved_at) и отвечает на вопрос «нужно ли заводить
    // документ по этому файлу»: NULL + NULL — нужно, см. stub-documents.ts.
    stubDocumentId: uuid('stub_document_id').references((): AnyPgColumn => sourceDocuments.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ключ upsert'а. Частичный: legacy-строки с NULL под него не попадают.
    uniqueIndex('bundle_import_items_input_file_unique')
      .on(t.bundleId, t.inputS3Key, t.uploadGeneration)
      .where(sql`${t.inputS3Key} is not null`),
    index('bundle_import_items_unresolved_idx')
      .on(t.effectiveStatus)
      .where(sql`${t.effectiveStatus} is not null and ${t.resolvedAt} is null`),
    // Нужен самой БД: без него ON DELETE SET NULL сканирует реестр целиком на
    // каждое удаление документа.
    index('bundle_import_items_stub_document_idx')
      .on(t.stubDocumentId)
      .where(sql`${t.stubDocumentId} is not null`),
  ],
);

// Манифест сегментов пакета: сегмент = один ЛОГИЧЕСКИЙ УПД, собранный из
// страниц (страницы могут лежать в разных файлах — россыпь фотографий).
//
// Манифест сохраняется, а не живёт в памяти задания, ради идемпотентности:
// повтор упавшего задания находит сегмент по (пакет, поколение, индекс) и не
// создаёт второй комплект документов. Публикация проставляет
// sourceDocumentId и publishedAt всем сегментам поколения одной транзакцией —
// до этого документов сегмента наружу не видно.
export const bundleSegments = pgTable(
  'bundle_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => sourceBundles.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    segmentIndex: integer('segment_index').notNull(),
    sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, {
      onDelete: 'set null',
    }),
    // PageRef[]: { registryItemId, inputOrder, pageInFile } — адрес каждой
    // страницы, переживающий пересборку и разделение документов.
    // registryItemId допускает null: у пакетов, принятых до появления реестра,
    // строки нет вовсе, и адресом остаётся порядковый номер файла.
    pageRefs: jsonb('page_refs')
      .$type<Array<{ registryItemId: string | null; inputOrder: number; pageInFile: number }>>()
      .notNull()
      .default([]),
    // normal | fallback | uncertain (см. segmentUpdPages). Поколение с
    // fallback/uncertain не публикуется автоматически — разбирает менеджер.
    confidence: text('confidence'),
    docNumber: text('doc_number'),
    docDate: timestamp('doc_date', { mode: 'date' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bundle_segments_slot_unique').on(t.bundleId, t.generation, t.segmentIndex),
    index('bundle_segments_document_idx')
      .on(t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
  ],
);

export const sourceDocumentItems = pgTable('source_document_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceDocumentId: uuid('source_document_id')
    .notNull()
    .references(() => sourceDocuments.id, { onDelete: 'cascade' }),
  materialId: uuid('material_id').references(() => materials.id, { onDelete: 'set null' }),
  nameRaw: text('name_raw').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unit: varchar('unit', { length: 16 }).notNull().default('шт'),
  price: numeric('price', { precision: 18, scale: 4 }),
  sum: numeric('sum', { precision: 18, scale: 2 }),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }),
  vatSum: numeric('vat_sum', { precision: 18, scale: 2 }),
  expectedDate: timestamp('expected_date', { mode: 'date' }),
  lineNo: integer('line_no').notNull(),
  volumeM3: numeric('volume_m3', { precision: 10, scale: 4 }),
  massKg: numeric('mass_kg', { precision: 10, scale: 3 }),
  volumeConfidence: text('volume_confidence'),
  groupName: text('group_name'),
  // Инвентарный номер ОС из ОС-2 (например «119866»). Заполняется только
  // для kind='os2_transfer'; у ТН и УПД остаётся NULL.
  inventoryNumber: text('inventory_number'),
});

export const sourceDocumentAttachments = pgTable('source_document_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceDocumentId: uuid('source_document_id')
    .notNull()
    .references(() => sourceDocuments.id, { onDelete: 'cascade' }),
  s3Key: text('s3_key').notNull(),
  filename: text('filename').notNull(),
  mimeType: varchar('mime_type', { length: 128 }),
  sizeBytes: integer('size_bytes'),
  role: attachmentRoleEnum('role').notNull().default('original'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── LLM calls log ─────────────────────────────────────────────────────────
// Журнал общения с LLM при распознавании документов: хранит сырой запрос и
// ответ, чтобы диагностировать ошибки распознавания. Доступен только админам.

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, {
      onDelete: 'cascade',
    }),
    providerId: uuid('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    promptId: uuid('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
    docKind: text('doc_kind').notNull(),
    model: text('model'),
    requestMessages: jsonb('request_messages').notNull(),
    requestSchema: jsonb('request_schema'),
    responseRaw: text('response_raw'),
    responseParsed: jsonb('response_parsed'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_calls_source_doc_idx').on(t.sourceDocumentId, t.createdAt),
    index('llm_calls_created_at_idx').on(t.createdAt),
  ],
);

// ─── Deliveries ────────────────────────────────────────────────────────────

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Короткий человекочитаемый id для столбца «id» в Принятых и
    // заголовка модалки «Приёмка #N». Авто-возрастающий через
    // sequence deliveries_display_id_seq (см. миграцию 0059).
    // DEFAULT в схеме не указываем — назначается БД, drizzle .values()
    // его не пишет, и БД использует nextval(seq).
    displayId: bigint('display_id', { mode: 'number' }).notNull(),
    statusId: uuid('status_id')
      .notNull()
      .references(() => statuses.id),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').references(() => counterparties.id, { onDelete: 'set null' }),
    contractorId: uuid('contractor_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    vehiclePlate: varchar('vehicle_plate', { length: 16 }),
    driverName: text('driver_name'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    inspectorId: uuid('inspector_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    // Транзит — приёмка является частью транзитного рейса (машина
    // разгрузилась и поехала с другим грузом). Чекбокс на 1 этапе мобилы.
    // См. миграцию 0051. Default false — legacy-записи в порядке.
    inTransit: boolean('in_transit').notNull().default(false),
    // ОС — флаг «основные средства»: накладная относится к движению
    // объектов основных средств (а не материалов). Чекбокс на 1 этапе
    // мобилы. См. миграцию 0065. Default false — legacy-записи в порядке.
    // Ортогонален статусу и kind; используется веб-порталом для бейджа и
    // будущей отчётности.
    isAssets: boolean('is_assets').notNull().default(false),
    confirmedByMolUserId: uuid('confirmed_by_mol_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedByMolAt: timestamp('confirmed_by_mol_at', { withTimezone: true }),
    // Отметка проверки качества (роль «Мониторинг», миграция 0070). Ортогональна
    // статусу: запись остаётся «Подтверждено МОЛ», а поверх лежит независимая
    // отметка QC. review_state: NULL = не проверено, 'approved' = проверено,
    // 'issues' = есть замечания (тогда review_note обязателен). Видна только
    // admin/manager/monitor (сервер обнуляет в buildDeliveryDto для прочих ролей).
    reviewState: varchar('review_state', { length: 16 }),
    reviewNote: text('review_note'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // МОЛ-получатель приёмки (физлицо собственной бригады). Альтернатива
    // contractor_id. CHECK не позволяет заполнить оба одновременно (миграция 0030).
    recipientMolId: uuid('recipient_mol_id').references(() => responsiblePersons.id, {
      onDelete: 'set null',
    }),
    // Источник для парных delivery, создаваемых из shipment.kind='transfer'.
    // Уникален по миграции 0031: один shipment → не более одного парного delivery.
    sourceShipmentId: uuid('source_shipment_id'),
    // Soft-delete: пометка на удаление. Окончательно стирает только админ.
    // Применимо к статусам filled/confirmed_mol; CHECK гарантирует, что три
    // поля заполнены/пусты согласованно.
    pendingDeletionAt: timestamp('pending_deletion_at', { withTimezone: true }),
    pendingDeletionByUserId: uuid('pending_deletion_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    pendingDeletionReason: text('pending_deletion_reason'),
    // Каким устройством заведена запись. Служебное поле: в DTO и /sync не
    // выводится, контракт не меняет. Сессия — это одно устройство между
    // логинами, поэтому пара «сессия + её last_seen_ua» отвечает на вопрос,
    // какой планшет объекта перестал присылать записи: без этого на объекте с
    // четырьмя планшетами молчащий полностью маскируется соседями.
    //
    // Заполняется ТОЛЬКО при создании — upsert его не трогает, иначе потерялось
    // бы, кто запись завёл. NULL допустим: исторические записи и парные
    // transfer-приёмки, которые создаёт сервер, а не планшет.
    createdBySessionId: uuid('created_by_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deliveries_site_idx').on(t.siteId, t.updatedAt),
    // Составной: запросы здоровья парка всегда идут парой «устройство + окно
    // времени», отдельные индексы по каждому полю тут дали бы хуже.
    index('deliveries_created_by_session_idx')
      .on(t.createdBySessionId, t.createdAt)
      .where(sql`${t.createdBySessionId} is not null`),
    index('deliveries_contractor_idx')
      .on(t.contractorId)
      .where(sql`${t.contractorId} is not null`),
    index('deliveries_recipient_mol_idx')
      .on(t.recipientMolId)
      .where(sql`${t.recipientMolId} is not null`),
    uniqueIndex('deliveries_source_shipment_unique')
      .on(t.sourceShipmentId)
      .where(sql`${t.sourceShipmentId} is not null`),
    index('deliveries_arrived_at_idx')
      .on(t.siteId, t.arrivedAt)
      .where(sql`${t.arrivedAt} is not null`),
    index('deliveries_pending_deletion_idx')
      .on(t.siteId, t.pendingDeletionAt)
      .where(sql`${t.pendingDeletionAt} is not null`),
    check(
      'deliveries_pending_deletion_chk',
      sql`(${t.pendingDeletionAt} is null and ${t.pendingDeletionByUserId} is null) or (${t.pendingDeletionAt} is not null and ${t.pendingDeletionByUserId} is not null)`,
    ),
    check(
      'deliveries_recipient_chk',
      sql`NOT (${t.contractorId} is not null AND ${t.recipientMolId} is not null)`,
    ),
  ],
);

export const deliverySources = pgTable(
  'delivery_sources',
  {
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    sourceDocumentId: uuid('source_document_id')
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // PK не даёт дубль одной и той же пары (delivery, source_document).
    // UNIQUE по source_document_id СНЯТ миграцией 0063 — одна УПД может
    // быть привязана к нескольким приёмкам (сценарий «несколько поставок»:
    // одна УПД на 50 т арматуры приезжает 4-5 рейсами, каждый рейс =
    // своя приёмка). В UI это режим «Несколько поставок» в
    // LinkSourceDocumentModal — явный тумблер у менеджера.
    primaryKey({ columns: [t.deliveryId, t.sourceDocumentId] }),
  ],
);

export const deliveryItems = pgTable(
  'delivery_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    materialId: uuid('material_id').references(() => materials.id, { onDelete: 'set null' }),
    // ПРОИСХОЖДЕНИЕ позиции, а не текущая связь: связь приёмки с документом
    // живёт в delivery_sources и снимается отвязкой, а это поле остаётся —
    // иначе после «Отвязать» неоткуда узнать, откуда взялась строка, и
    // повторная привязка вынуждена угадывать по названию и количеству.
    // NULL — действительно неизвестное происхождение (ручной ввод; для истории
    // до миграции 0096 — то, что не удалось сопоставить однозначно).
    // RESTRICT: документ, чьи позиции попали в приёмку, удалять нельзя, только
    // архивировать.
    sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, {
      onDelete: 'restrict',
    }),
    // Точная исходная строка документа. SET NULL, а не RESTRICT: повторный
    // разбор УПД удаляет и пересоздаёт source_document_items, и RESTRICT
    // заблокировал бы переразбор. Документ при этом остаётся известен.
    sourceDocumentItemId: uuid('source_document_item_id').references(
      () => sourceDocumentItems.id,
      { onDelete: 'set null' },
    ),
    // Тип позиции: 'material' (по умолчанию) или 'asset' (ОС). См. миграцию 0029.
    itemKind: itemKindEnum('item_kind').notNull().default('material'),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    inventoryNumber: text('inventory_number'),
    serialNumber: text('serial_number'),
    nameRaw: text('name_raw').notNull(),
    qtyPlanned: numeric('qty_planned', { precision: 18, scale: 4 }),
    qtyActual: numeric('qty_actual', { precision: 18, scale: 4 }),
    unit: varchar('unit', { length: 16 }).notNull().default('шт'),
    comment: text('comment'),
    lineNo: integer('line_no').notNull(),
    volumeM3: numeric('volume_m3', { precision: 10, scale: 4 }),
    massKg: numeric('mass_kg', { precision: 10, scale: 3 }),
    price: numeric('price', { precision: 18, scale: 4 }),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }),
    vatSum: numeric('vat_sum', { precision: 18, scale: 2 }),
    volumeConfidence: text('volume_confidence'),
    groupName: text('group_name'),
  },
  (t) => [
    index('delivery_items_asset_idx').on(t.assetId).where(sql`${t.assetId} is not null`),
    // Позиции одного документа: секции «УПД № … · Материалы (N)» в приёмке и
    // проверка «эта строка действительно из этого УПД».
    index('delivery_items_source_document_idx')
      .on(t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
    check(
      'delivery_items_kind_target_chk',
      sql`(${t.itemKind} = 'material' AND ${t.assetId} IS NULL)
          OR (${t.itemKind} = 'asset' AND ${t.assetId} IS NOT NULL AND ${t.materialId} IS NULL)`,
    ),
  ],
);

export const deliveryPhotos = pgTable(
  'delivery_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    kind: photoKindEnum('kind').notNull().default('cargo'),
    // Этап приёмки. Мобильный клиент проставляет при presign в зависимости от
    // того, на каком шаге пользователь нажал «Сделать фото». Default 'before'
    // покрывает старые версии клиентов и backfill (см. миграцию 0037).
    stage: deliveryPhotoStageEnum('stage').notNull().default('before'),
    s3Key: text('s3_key').notNull(),
    thumbS3Key: text('thumb_s3_key'),
    contentHash: varchar('content_hash', { length: 64 }),
    idempotencyKey: uuid('idempotency_key'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    // Подтверждение успешного PUT в S3 (POST /photos/{id}/confirm). NULL =
    // orphan-запись, фото в S3 ещё не загружено; через час фоновая job
    // photoOrphanCleanup проверит S3.HEAD и либо проставит uploaded_at, либо
    // удалит запись.
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('delivery_photo_content_unique')
      .on(t.deliveryId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    uniqueIndex('delivery_photo_idempotency_unique')
      .on(t.deliveryId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // По created_at, а не takenAt: с 1.0.33 время съёмки присылает планшет и
    // у офлайн-фото оно может быть суточной давности (см. photo-orphan-cleanup).
    index('delivery_photos_orphan_idx')
      .on(t.createdAt)
      .where(sql`${t.uploadedAt} is null`),
  ],
);

// ─── Shipments (отгрузка) ──────────────────────────────────────────────────

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Короткий человекочитаемый id — симметрично с deliveries.displayId.
    // Авто-возрастающий через sequence shipments_display_id_seq
    // (см. миграцию 0059).
    displayId: bigint('display_id', { mode: 'number' }).notNull(),
    statusId: uuid('status_id')
      .notNull()
      .references(() => statuses.id),
    kind: shipmentKindEnum('kind').notNull(),
    // Тип отгрузки (purpose) — семантическая категория, отдельная от kind.
    // Заполняется инспектором на мобиле (dropdown на форме «Новая отгрузка»):
    // «Вывоз материала», «Перемещение на объект», «Вывоз мусора», «Другое».
    // На веб-портале — чип «Тип отгрузки: …» в шапке карточки.
    // Тип text (не enum) — список расширяется без миграции БД.
    // См. миграцию 0050. NULL для legacy и для отгрузок с УПД.
    purpose: text('purpose'),
    // Транзит — зеркало deliveries.in_transit. Чекбокс на 1 этапе мобилы.
    // См. миграцию 0051. Default false — legacy-записи в порядке.
    inTransit: boolean('in_transit').notNull().default(false),
    // ОС — зеркало deliveries.is_assets. Чекбокс на 1 этапе мобилы.
    // См. миграцию 0065. Default false — legacy-записи в порядке.
    isAssets: boolean('is_assets').notNull().default(false),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    receiverCounterpartyId: uuid('receiver_counterparty_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    // МОЛ-получатель отгрузки (физлицо собственной бригады). Альтернатива
    // receiver_counterparty_id для kind in ('contractor','transfer').
    // См. миграцию 0030 и shipments_kind_links_chk.
    receiverMolId: uuid('receiver_mol_id').references(() => responsiblePersons.id, {
      onDelete: 'set null',
    }),
    destSiteId: uuid('dest_site_id').references(() => sites.id, { onDelete: 'restrict' }),
    // Поставщик материала, который отгружаем. Зеркало deliveries.supplier_id
    // — для симметрии шапок «Приёмка / Отгрузка» в портале. Менеджер
    // выбирает из Справочника → Поставщики; бэк апсертит counterparty
    // по ИНН (см. PATCH /api/v1/shipments/:id/supplier-from-directory).
    // Миграция 0056. NULL для transfer/writeoff/return и legacy.
    supplierId: uuid('supplier_id').references(() => counterparties.id, { onDelete: 'set null' }),
    vehiclePlate: varchar('vehicle_plate', { length: 16 }),
    driverName: text('driver_name'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    inspectorId: uuid('inspector_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    confirmedByMolUserId: uuid('confirmed_by_mol_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedByMolAt: timestamp('confirmed_by_mol_at', { withTimezone: true }),
    // Отметка проверки качества (роль «Мониторинг», миграция 0070) — зеркало
    // одноимённых полей deliveries. Ортогональна статусу; видна только
    // admin/manager/monitor (сервер обнуляет в buildShipmentDto для прочих ролей).
    reviewState: varchar('review_state', { length: 16 }),
    reviewNote: text('review_note'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    // Soft-delete: см. одноимённые поля в deliveries.
    pendingDeletionAt: timestamp('pending_deletion_at', { withTimezone: true }),
    pendingDeletionByUserId: uuid('pending_deletion_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    pendingDeletionReason: text('pending_deletion_reason'),
    // Каким устройством заведена запись — зеркало одноимённого поля deliveries.
    // Служебное: в DTO и /sync не выводится, заполняется только при создании.
    createdBySessionId: uuid('created_by_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipment_site_updated_idx').on(t.siteId, t.updatedAt),
    index('shipments_created_by_session_idx')
      .on(t.createdBySessionId, t.createdAt)
      .where(sql`${t.createdBySessionId} is not null`),
    index('shipment_kind_idx').on(t.kind),
    index('shipment_inspector_idx').on(t.inspectorId),
    index('shipment_dest_site_idx')
      .on(t.destSiteId)
      .where(sql`${t.kind} = 'transfer'`),
    index('shipment_receiver_idx')
      .on(t.receiverCounterpartyId)
      .where(sql`${t.receiverCounterpartyId} is not null`),
    index('shipments_receiver_mol_idx')
      .on(t.receiverMolId)
      .where(sql`${t.receiverMolId} is not null`),
    index('shipments_shipped_at_idx')
      .on(t.siteId, t.shippedAt)
      .where(sql`${t.shippedAt} is not null`),
    index('shipments_pending_deletion_idx')
      .on(t.siteId, t.pendingDeletionAt)
      .where(sql`${t.pendingDeletionAt} is not null`),
    check(
      'shipments_pending_deletion_chk',
      sql`(${t.pendingDeletionAt} is null and ${t.pendingDeletionByUserId} is null) or (${t.pendingDeletionAt} is not null and ${t.pendingDeletionByUserId} is not null)`,
    ),
    // Соответствие kind и набора получателей/направления. См. миграции
    // 0030 и 0052 (для kind='contractor' допустимы оба NULL = empty-draft).
    check(
      'shipments_kind_links_chk',
      sql`(
        (${t.kind} = 'contractor'
          AND NOT (${t.receiverCounterpartyId} IS NOT NULL AND ${t.receiverMolId} IS NOT NULL)
          AND ${t.destSiteId} IS NULL)
        OR (${t.kind} = 'return'
          AND ${t.receiverCounterpartyId} IS NOT NULL
          AND ${t.receiverMolId} IS NULL
          AND ${t.destSiteId} IS NULL)
        OR (${t.kind} = 'transfer'
          AND ${t.destSiteId} IS NOT NULL
          AND ${t.destSiteId} <> ${t.siteId}
          AND ((${t.receiverCounterpartyId} IS NOT NULL) <> (${t.receiverMolId} IS NOT NULL)))
        OR (${t.kind} = 'writeoff'
          AND ${t.receiverCounterpartyId} IS NULL
          AND ${t.receiverMolId} IS NULL
          AND ${t.destSiteId} IS NULL)
      )`,
    ),
  ],
);

export const shipmentSources = pgTable(
  'shipment_sources',
  {
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    sourceDocumentId: uuid('source_document_id')
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: 'restrict' }),
  },
  (t) => [
    // См. комментарий в deliverySources: UNIQUE по source_document_id
    // снят миграцией 0063 (одна УПД → N отгрузок). PK по паре остаётся.
    primaryKey({ columns: [t.shipmentId, t.sourceDocumentId] }),
  ],
);

export const shipmentItems = pgTable(
  'shipment_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    materialId: uuid('material_id').references(() => materials.id, { onDelete: 'set null' }),
    // ПРОИСХОЖДЕНИЕ позиции — зеркало delivery_items, см. миграцию 0103.
    // Связь отгрузки с документом живёт в shipment_sources и снимается
    // отвязкой, а это поле остаётся. NULL — действительно неизвестное
    // происхождение: ручной ввод либо отгрузка, оформленная до 0103.
    sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, {
      onDelete: 'restrict',
    }),
    // SET NULL, а не RESTRICT: повторный разбор документа пересоздаёт
    // source_document_items, и RESTRICT заблокировал бы переразбор.
    sourceDocumentItemId: uuid('source_document_item_id').references(
      () => sourceDocumentItems.id,
      { onDelete: 'set null' },
    ),
    // Тип позиции: 'material' (по умолчанию) или 'asset' (ОС). См. миграцию 0029.
    itemKind: itemKindEnum('item_kind').notNull().default('material'),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    inventoryNumber: text('inventory_number'),
    serialNumber: text('serial_number'),
    nameRaw: text('name_raw').notNull(),
    qtyPlanned: numeric('qty_planned', { precision: 18, scale: 4 }),
    qtyActual: numeric('qty_actual', { precision: 18, scale: 4 }),
    unit: varchar('unit', { length: 16 }).notNull().default('шт'),
    comment: text('comment'),
    lineNo: integer('line_no').notNull(),
    volumeM3: numeric('volume_m3', { precision: 10, scale: 4 }),
    massKg: numeric('mass_kg', { precision: 10, scale: 3 }),
    price: numeric('price', { precision: 18, scale: 4 }),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }),
    vatSum: numeric('vat_sum', { precision: 18, scale: 2 }),
    volumeConfidence: text('volume_confidence'),
    groupName: text('group_name'),
  },
  (t) => [
    index('shipment_items_material_idx').on(t.materialId),
    index('shipment_items_source_document_idx')
      .on(t.sourceDocumentId)
      .where(sql`${t.sourceDocumentId} is not null`),
    index('shipment_items_asset_idx').on(t.assetId).where(sql`${t.assetId} is not null`),
    check(
      'shipment_items_kind_target_chk',
      sql`(${t.itemKind} = 'material' AND ${t.assetId} IS NULL)
          OR (${t.itemKind} = 'asset' AND ${t.assetId} IS NOT NULL AND ${t.materialId} IS NULL)`,
    ),
  ],
);

export const shipmentPhotos = pgTable(
  'shipment_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    kind: photoKindEnum('kind').notNull().default('cargo'),
    stage: shipmentPhotoStageEnum('stage').notNull().default('before'),
    s3Key: text('s3_key').notNull(),
    thumbS3Key: text('thumb_s3_key'),
    contentHash: varchar('content_hash', { length: 64 }),
    idempotencyKey: uuid('idempotency_key'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipment_photo_content_unique')
      .on(t.shipmentId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    uniqueIndex('shipment_photo_idempotency_unique')
      .on(t.shipmentId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // По created_at, а не takenAt: с 1.0.33 время съёмки присылает планшет и
    // у офлайн-фото оно может быть суточной давности (см. photo-orphan-cleanup).
    index('shipment_photos_orphan_idx')
      .on(t.createdAt)
      .where(sql`${t.uploadedAt} is null`),
  ],
);

// ─── Кэш распознавания фото-документа ─────────────────────────────────────
// См. миграцию 0058. Polymorphic FK: ровно одна из ссылок — delivery или
// shipment, гарантировано CHECK photo_recognized_one_photo_chk на уровне БД.
// items — JSONB-массив { nameRaw, qty, unit, price, sum, invNumber } из
// LLM-парсера (domain/edo/waybill-batch.parser.ts).
//
// Тип items не делаем строго типизированным через $type<...> чтобы не
// связываться с public-контрактом WaybillBatchParsed: формат может
// меняться, а кэш — служебный (читается только из routes/photos.ts +
// возвращается через PhotoRecognitionItemSchema).

export const photoRecognizedItems = pgTable(
  'photo_recognized_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryPhotoId: uuid('delivery_photo_id').references(() => deliveryPhotos.id, {
      onDelete: 'cascade',
    }),
    shipmentPhotoId: uuid('shipment_photo_id').references(() => shipmentPhotos.id, {
      onDelete: 'cascade',
    }),
    items: jsonb('items').notNull().default(sql`'[]'::jsonb`),
    docForm: varchar('doc_form', { length: 32 }),
    docNumber: text('doc_number'),
    docDate: timestamp('doc_date', { withTimezone: false, mode: 'string' }),
    totalSum: numeric('total_sum', { precision: 20, scale: 2 }),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    model: text('model'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('photo_recognized_delivery_uidx')
      .on(t.deliveryPhotoId)
      .where(sql`${t.deliveryPhotoId} is not null`),
    uniqueIndex('photo_recognized_shipment_uidx')
      .on(t.shipmentPhotoId)
      .where(sql`${t.shipmentPhotoId} is not null`),
    check(
      'photo_recognized_one_photo_chk',
      sql`((${t.deliveryPhotoId} IS NOT NULL)::int + (${t.shipmentPhotoId} IS NOT NULL)::int) = 1`,
    ),
  ],
);

// ─── Entity deletions (журнал hard-delete для офлайн-клиента) ──────────────

export const entityDeletions = pgTable(
  'entity_deletions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'delivery' | 'shipment' | 'source_document' | 'asset' | 'responsible_person' —
    // CHECK в миграциях 0025 (исходный) и 0032 (расширение).
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('entity_deletions_since_idx').on(t.entityType, t.deletedAt),
    index('entity_deletions_site_idx')
      .on(t.entityType, t.siteId, t.deletedAt)
      .where(sql`${t.siteId} is not null`),
    check(
      'entity_deletions_type_chk',
      sql`${t.entityType} in ('delivery', 'shipment', 'source_document', 'asset', 'responsible_person')`,
    ),
  ],
);

// ─── S3 cleanup outbox (transactional) ──────────────────────────────────────
// Надёжная дочистка S3-объектов при удалении приёмки/отгрузки. Строки пишутся
// В ТОЙ ЖЕ транзакции, что и удаление операции (см. routes/deliveries|shipments),
// поэтому недоступность Redis/S3 в момент удаления не теряет задание — воркер
// заберёт его позже. Обработка воркером: батч под FOR UPDATE SKIP LOCKED →
// пометка processing_at → идемпотентный DELETE S3-объекта → успех: строка
// удаляется; ошибка: attempts++ и next_attempt_at с backoff. processing_at —
// лизинг: зависшие после краша воркера строки возвращаются в очередь по истечении.
export const s3CleanupOutbox = pgTable(
  's3_cleanup_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    s3Key: text('s3_key').notNull(),
    // Трассировка источника (не FK — операция уже удалена каскадом).
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    processingAt: timestamp('processing_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Выборка готовых к обработке: next_attempt_at <= now() среди «свободных».
    index('s3_cleanup_outbox_ready_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.processingAt} is null`),
  ],
);

// ─── Job outbox (надёжная постановка задач в очередь) ─────────────────────

// Задание пишется в ТОЙ ЖЕ транзакции, что и бизнес-запись (пакет, документ),
// поэтому недоступность Redis в момент коммита больше не оставляет пакет в
// статусе queued без job. Consumer в воркере разбирает строки батчем
// (FOR UPDATE SKIP LOCKED + лизинг) и ставит их в BullMQ.
//
// dedupe_key — ДИСПЕТЧЕРСКИЙ идентификатор попытки (`bundle~<id>~parse~<gen>`),
// а не идентификатор сущности: BullMQ хранит завершённые jobs сутки
// (removeOnComplete), поэтому jobId вида `bundle:<id>` заставил бы намеренный
// повторный разбор молча не запуститься. Он же передаётся в queue.add как
// jobId, поэтому повторная обработка ТОЙ ЖЕ строки outbox дубля не создаёт.
export const jobOutbox = pgTable(
  'job_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queue: text('queue').notNull(),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    processingAt: timestamp('processing_at', { withTimezone: true }),
    // Ставит ТОЛЬКО сторож/recovery: разрешает снять завершённый job с тем же
    // jobId и поставить его заново. Обычная доставка так делать не вправе —
    // существующий job для неё означает «уже доставлено», иначе падение между
    // queue.add и удалением строки привело бы к повторному выполнению уже
    // отработавшего задания.
    replaceTerminal: boolean('replace_terminal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Одна попытка диспетчеризации — одна строка.
    uniqueIndex('job_outbox_dedupe_key_unique').on(t.dedupeKey),
    // Выборка готовых к отправке среди «свободных» (как у s3_cleanup_outbox).
    index('job_outbox_ready_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.processingAt} is null`),
  ],
);

// ─── Почтовый канал приёма документов ─────────────────────────────────────

// mail_receipts — ТОЛЬКО транспорт: что удалось забрать из IMAP. Строка
// создаётся ДО загрузки тела письма, поэтому падению на fetch/MIME/S3 есть
// куда записать попытку.
export const mailReceipts = pgTable(
  'mail_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailAccountId: uuid('mail_account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }).notNull(),
    // fetching | parsed | skipped_by_size | fetch_failed | parse_failed | vanished
    // Терминальные двигают watermark; fetch_failed/parse_failed — только после
    // исчерпания попыток.
    status: text('status').notNull().default('fetching'),
    rfc822Size: bigint('rfc822_size', { mode: 'number' }),
    rawS3Key: text('raw_s3_key'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // Оператор попросил забрать письмо заново. Отдельная отметка, а не статус
    // `fetching`: тот же статус стоит у попытки, которая идёт прямо сейчас.
    // Письмо с исчерпанными попытками watermark уже перешагнул, и вернуться к
    // нему можно только точечным дозабором по UID.
    replayRequestedAt: timestamp('replay_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_receipts_uid_unique').on(t.mailAccountId, t.uidValidity, t.uid),
    index('mail_receipts_status_idx').on(t.mailAccountId, t.status),
    index('mail_receipts_replay_idx')
      .on(t.mailAccountId, t.uidValidity, t.uid)
      .where(sql`replay_requested_at is not null`),
  ],
);

// mail_messages — ТОЛЬКО бизнес-состояние письма. Строка создаётся для
// КАЖДОГО разобранного письма, включая ignored/no_attachments/rejected_sender:
// иначе эти исходы негде хранить и письмо пропадает из наблюдаемости.
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailAccountId: uuid('mail_account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    receiptId: uuid('receipt_id').references(() => mailReceipts.id, { onDelete: 'set null' }),
    // sha256 от СЫРОГО .eml, не от Message-ID: хеш по заголовку позволил бы
    // отправителю подделать Message-ID настоящего письма и добиться того, что
    // подлинный УПД молча отбросится как дубль.
    messageHash: varchar('message_hash', { length: 64 }).notNull(),
    messageIdHeader: text('message_id_header'),
    fromAddress: text('from_address'),
    subject: text('subject'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    // quarantined | resolving | ingested | rejected | ignored | no_attachments | rejected_sender
    status: text('status').notNull().default('quarantined'),
    rejectReason: text('reject_reason'),
    bundleId: uuid('bundle_id').references(() => sourceBundles.id, { onDelete: 'set null' }),
    // Токен саги resolve: T2 закрывается только своим токеном, поэтому
    // повторный resolve чужой попытки не «докатывает» её наполовину.
    resolveToken: uuid('resolve_token'),
    resolveStartedAt: timestamp('resolve_started_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    suggestedSiteId: uuid('suggested_site_id').references(() => sites.id, { onDelete: 'set null' }),
    suggestedDirection: sourceDirectionEnum('suggested_direction'),
    rawS3Key: text('raw_s3_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_messages_hash_unique').on(t.mailAccountId, t.messageHash),
    index('mail_messages_status_idx').on(t.status, t.createdAt),
    // Для компенсации зависших саг.
    index('mail_messages_resolving_idx')
      .on(t.resolveStartedAt)
      .where(sql`status = 'resolving'`),
  ],
);

// Нормализованная таблица, не jsonb: даёт FK, индексы и атомарный restore
// вложения вместо перезаписи json-массива.
export const mailAttachments = pgTable(
  'mail_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailMessageId: uuid('mail_message_id')
      .notNull()
      .references(() => mailMessages.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    filename: text('filename'),
    declaredMime: text('declared_mime'),
    sniffedMime: text('sniffed_mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: varchar('sha256', { length: 64 }),
    stagingS3Key: text('staging_s3_key'),
    // kept | suspected_signature | skipped | restored
    // Фильтр подписей ничего не удаляет: мелкая картинка (< 25 КБ) и штамп
    // почтового клиента откладываются, файл остаётся в хранилище и виден
    // оператору. Ошибка обратима кнопкой «Вернуть» — состояние `restored`
    // идёт в пакет наравне с `kept`.
    state: text('state').notNull().default('kept'),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mail_attachments_message_idx_unique').on(t.mailMessageId, t.idx),
    index('mail_attachments_staging_key_idx')
      .on(t.stagingS3Key)
      .where(sql`${t.stagingS3Key} is not null`),
  ],
);

// Правила предзаполнения карточки разбора. Матчинг темы — substring/glob,
// НЕ regex: выражение приходит от пользователя и regex открывает ReDoS.
export const mailRoutes = pgTable(
  'mail_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mailAccountId: uuid('mail_account_id')
      .notNull()
      .references(() => mailAccounts.id, { onDelete: 'cascade' }),
    // from | subject
    matchType: text('match_type').notNull(),
    matchValue: text('match_value').notNull(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    direction: sourceDirectionEnum('direction'),
    contractorId: uuid('contractor_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    // admin-only: manager через «запомнить маршрут» создаёт правило только с
    // auto_process = false. Автообработка требует проверенных SPF/DKIM/DMARC.
    autoProcess: boolean('auto_process').notNull().default(false),
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mail_routes_account_idx')
      .on(t.mailAccountId, t.priority)
      .where(sql`is_active = true`),
  ],
);

// Provenance пакета отдельной таблицей: один пакет может прийти вручную И
// несколькими письмами, поэтому одиночные mail_account_id/message_id в самом
// пакете были бы неверны.
export const ingestEvents = pgTable(
  'ingest_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => sourceBundles.id, { onDelete: 'cascade' }),
    // manual | mail | public
    channel: text('channel').notNull(),
    mailMessageId: uuid('mail_message_id').references(() => mailMessages.id, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Попытка загрузить тот же контент в другой scope — фиксируем, а не
    // молча возвращаем чужой пакет.
    crossScopeOf: uuid('cross_scope_of').references((): AnyPgColumn => sourceBundles.id, {
      onDelete: 'set null',
    }),
    // ─── channel='public': отправка с публичной страницы /uploads ───
    // Непрозрачный идентификатор обращения — единственное, что уходит наружу.
    // Внутренний bundle_id поставщику не отдаётся: иначе статус-эндпоинт
    // принимал бы внутренние UUID и, зная чужой id, аноним опрашивал бы
    // состояние внутренних пакетов.
    publicTicket: varchar('public_ticket', { length: 32 }),
    // Свободный комментарий поставщика к этой поставке («две машины, вторая
    // после обеда»). Недоверенный текст: только для показа менеджеру, ни на
    // что в системе не влияет. Контактные поля отсюда убраны миграцией 0082 —
    // телефон был персональными данными без реальной пользы.
    submissionComment: text('submission_comment'),
    // Техническая запись на случай разбора злоупотреблений: наружу и в
    // интерфейс не выводится.
    submitterIp: text('submitter_ip'),
    submitterUserAgent: text('submitter_user_agent'),
    // Имена файлов ИМЕННО ЭТОЙ отправки и вердикт входного фильтра по каждому:
    // [{ filename, accepted, reason? }]. Пакет может быть переиспользован, а
    // те же байты внутри могли быть загружены под другими именами — без
    // манифеста публичный статус раскрыл бы внутреннее имя файла.
    submissionManifest: jsonb('submission_manifest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ingest_events_bundle_idx').on(t.bundleId, t.createdAt),
    uniqueIndex('ingest_events_public_ticket_unique')
      .on(t.publicTicket)
      .where(sql`${t.publicTicket} is not null`),
  ],
);

// ─── Share-tokens (публичные ссылки на просмотр приёмки/отгрузки) ─────────

// Менеджер генерирует ссылку, отправляет внешнему получателю (например,
// поставщику). Тот открывает /share/{token} без авторизации и видит
// read-only карточку с фото и материалами. TTL по умолчанию 10 дней.
// Фото проксируются через API (см. routes/share.ts), S3-URL не светится.
export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(), // 'delivery' | 'shipment'
    entityId: uuid('entity_id').notNull(),
    token: varchar('token', { length: 64 }).notNull().unique(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    accessedCount: integer('accessed_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    lastAccessedIp: text('last_accessed_ip'),
    lastAccessedUserAgent: text('last_accessed_user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('share_tokens_entity_active_idx')
      .on(t.entityType, t.entityId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// ─── Share messages: чат на публичной share-странице ──────────────────────
//
// Привязка к share_tokens по CASCADE. sender_type='external' — без логина
// (поля name/email из формы). sender_type='manager' — автор ссылки (или
// другой админ/менеджер с доступом), берём ФИО из users.
// Для уведомлений у менеджера в портале: badge показывает сумму external+
// is_read=false по токенам, где created_by_user_id = me.
export const shareMessages = pgTable(
  'share_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shareTokenId: uuid('share_token_id')
      .notNull()
      .references(() => shareTokens.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(),       // 'external' | 'manager'
    senderUserId: uuid('sender_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    senderName: text('sender_name'),
    senderEmail: text('sender_email'),
    body: text('body').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('share_messages_token_created_idx').on(t.shareTokenId, t.createdAt),
    index('share_messages_unread_partial_idx')
      .on(t.shareTokenId)
      .where(sql`${t.isRead} = false and ${t.senderType} = 'external'`),
  ],
);

// ─── Claim группы: одна машина — одна операция ─────────────────────────────
//
// Объявлено в конце файла намеренно: таблица ссылается и на deliveries, и на
// shipments, а shipments описан ниже deliveries.
//
// Проверкой в коде инвариант не удержать — два планшета создают операцию по
// одной группе одновременно, и оба видят её свободной. PRIMARY KEY
// (operationKind, groupId) превращает второй заезд в ошибку уникальности внутри
// транзакции создания.
//
// Группа занята ЛЮБОЙ неудалённой операцией, включая завершённую
// (confirmed_mol): иначе ту же машину можно принять повторно на следующий день.
// Сценарий «несколько рейсов по одному УПД» — осознанное действие менеджера: оно
// пишет событие release и удаляет активную строку.
//
// Приёмки и отгрузки в одной таблице, а не в двух зеркальных: групповой путь
// отгрузки на планшете уже реализован, и отдельная таблица понадобилась бы сразу.
export const operationGroupClaims = pgTable(
  'operation_group_claims',
  {
    // 'delivery' | 'shipment'. text + CHECK вместо enum: новое значение enum
    // нельзя использовать в той же транзакции (55P04, грабли миграции 0015).
    operationKind: text('operation_kind').notNull(),
    // Корневой пакет машины.
    groupId: uuid('group_id')
      .notNull()
      .references(() => sourceBundles.id, { onDelete: 'cascade' }),
    // Ровно одна из двух ссылок заполнена — какая, определяет operationKind.
    // Полиморфный operationId без FK оставил бы claim жить после удаления
    // операции, заблокировав группу навсегда.
    deliveryId: uuid('delivery_id').references(() => deliveries.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id').references(() => shipments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    primaryKey({ columns: [t.operationKind, t.groupId] }),
    check('operation_group_claims_kind_check', sql`${t.operationKind} in ('delivery', 'shipment')`),
    check(
      'operation_group_claims_one_operation_check',
      sql`(${t.operationKind} = 'delivery' and ${t.deliveryId} is not null and ${t.shipmentId} is null)
          or (${t.operationKind} = 'shipment' and ${t.shipmentId} is not null and ${t.deliveryId} is null)`,
    ),
    // Одна операция держит не больше одной группы: приёмка из двух машин заняла
    // бы обе, и освободить их по отдельности стало бы нечем.
    uniqueIndex('operation_group_claims_delivery_uniq')
      .on(t.deliveryId)
      .where(sql`${t.deliveryId} is not null`),
    uniqueIndex('operation_group_claims_shipment_uniq')
      .on(t.shipmentId)
      .where(sql`${t.shipmentId} is not null`),
  ],
);

// История claim'ов. Отдельной таблицей, потому что активная строка при
// освобождении удаляется, и аудит ушёл бы вместе с ней.
//
// FK на группу и операцию НАМЕРЕННО НЕТ: история обязана пережить удаление и
// пакета, и приёмки — именно тогда вопрос «кто снял claim» и задают.
export const operationGroupClaimEvents = pgTable(
  'operation_group_claim_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationKind: text('operation_kind').notNull(),
    groupId: uuid('group_id').notNull(),
    operationId: uuid('operation_id'),
    // 'create' | 'release' | 'reclaim'
    event: text('event').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'operation_group_claim_events_kind_check',
      sql`${t.operationKind} in ('delivery', 'shipment')`,
    ),
    check(
      'operation_group_claim_events_event_check',
      sql`${t.event} in ('create', 'release', 'reclaim')`,
    ),
    index('operation_group_claim_events_group_idx').on(t.groupId, t.createdAt),
  ],
);

// ─── Журнал видимости документов на планшете ───────────────────────────────
//
// Документ может перестать быть видимым, оставаясь в базе: ушёл из parsed при
// переразборе, потерял объект или дату, попал в группу, где соседний документ
// ещё обрабатывается. Дельта /sync отбирает по updated_at и такого не покажет —
// у скрытого документа он не менялся. Планшет продолжал бы видеть машину,
// которой больше нет.
//
// Журнал, а не вычисление на лету: «что пропало с прошлого since» выводится
// только из сравнения двух снимков, а второго снимка нет ни у сервера, ни у
// клиента. Планшет уходит в офлайн на дни — за это время документ мог скрыться
// и снова появиться.
export const sourceDocumentVisibilityEvents = pgTable(
  'source_document_visibility_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Без FK: событие «скрыт» обязано пережить удаление документа, иначе
    // вернувшийся из офлайна планшет не узнает об исчезновении.
    sourceDocumentId: uuid('source_document_id').notNull(),
    // 'hidden' | 'visible'
    visibility: text('visibility').notNull(),
    // Для фильтра инспектора КПП по своему объекту. NULL допустим — документ мог
    // остаться без объекта, из-за чего и скрылся.
    siteId: uuid('site_id'),
    // Заполнена, когда документ скрыт вместе со всей машиной.
    groupId: uuid('group_id'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'source_document_visibility_events_visibility_check',
      sql`${t.visibility} in ('hidden', 'visible')`,
    ),
    index('source_document_visibility_events_cursor_idx').on(t.createdAt, t.id),
    index('source_document_visibility_events_document_idx').on(
      t.sourceDocumentId,
      desc(t.createdAt),
    ),
    index('source_document_visibility_events_site_idx')
      .on(t.siteId, t.createdAt)
      .where(sql`${t.siteId} is not null`),
  ],
);

// ─── Sync log ──────────────────────────────────────────────────────────────

export const syncLog = pgTable('sync_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  itemsIn: integer('items_in').notNull().default(0),
  itemsOut: integer('items_out').notNull().default(0),
  errorText: text('error_text'),
});
