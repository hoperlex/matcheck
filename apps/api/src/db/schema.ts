import { sql } from 'drizzle-orm';
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
  bigserial,
} from 'drizzle-orm/pg-core';
import type { UpdValidation } from '@matcheck/contracts';

// ─── Enums ─────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'manager', 'inspector_kpp']);
export const shipmentKindEnum = pgEnum('shipment_kind', [
  'contractor',
  'return',
  'transfer',
  'writeoff',
]);
export const sourceKindEnum = pgEnum('source_kind', ['upd', 'request']);
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
export const llmKindEnum = pgEnum('llm_kind', [
  'openrouter',
  'google_ai_studio',
  'qwen_self_hosted',
  'vertex',
]);
export const attachmentRoleEnum = pgEnum('attachment_role', ['original', 'extracted_text']);

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
    // Объект, к которому привязан пользователь. Обязателен для inspector_kpp
    // (определяет область видимости приёмок/отгрузок/документов).
    // Для admin/manager всегда null.
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionsInvalidatedAt: timestamp('sessions_invalidated_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_site_idx').on(t.siteId).where(sql`${t.siteId} is not null`),
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
  (t) => [uniqueIndex('refresh_token_hash_unique').on(t.tokenHash)],
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

// ─── Counterparties / Materials ─────────────────────────────────────────────

export const counterparties = pgTable(
  'counterparties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inn: varchar('inn', { length: 12 }).notNull(),
    kpp: varchar('kpp', { length: 9 }),
    name: text('name').notNull(),
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

// ─── Sites (объекты строительства) ─────────────────────────────────────────

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 5 }).notNull(),
    name: text('name').notNull(),
    fullName: text('full_name'),
    address: text('address'),
    isActive: boolean('is_active').notNull().default(true),
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
  lastUid: integer('last_uid'),
  isActive: boolean('is_active').notNull().default(true),
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
  maxTokens: integer('max_tokens').notNull().default(4096),
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
    recipientId: uuid('recipient_id').references(() => counterparties.id, { onDelete: 'set null' }),
    contractorId: uuid('contractor_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
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
    version: integer('version').notNull().default(1),
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
    index('source_contractor_idx')
      .on(t.contractorId)
      .where(sql`${t.contractorId} is not null`),
    index('source_site_idx').on(t.siteId).where(sql`${t.siteId} is not null`),
    index('source_documents_content_hash_idx')
      .on(t.contractorId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    index('source_documents_unfinished_idx')
      .on(t.status, t.parsedAt)
      .where(sql`${t.status} in ('queued', 'processing')`),
    check(
      'source_upd_required',
      sql`(${t.kind} <> 'upd') or (${t.status} <> 'parsed') or (${t.docNumber} is not null and ${t.docDate} is not null and ${t.totalSum} is not null)`,
    ),
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
    confirmedByMolUserId: uuid('confirmed_by_mol_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedByMolAt: timestamp('confirmed_by_mol_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deliveries_site_idx').on(t.siteId, t.updatedAt),
    index('deliveries_contractor_idx')
      .on(t.contractorId)
      .where(sql`${t.contractorId} is not null`),
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
  (t) => [primaryKey({ columns: [t.deliveryId, t.sourceDocumentId] })],
);

export const deliveryItems = pgTable('delivery_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id')
    .notNull()
    .references(() => deliveries.id, { onDelete: 'cascade' }),
  materialId: uuid('material_id').references(() => materials.id, { onDelete: 'set null' }),
  nameRaw: text('name_raw').notNull(),
  qtyPlanned: numeric('qty_planned', { precision: 18, scale: 4 }),
  qtyActual: numeric('qty_actual', { precision: 18, scale: 4 }),
  unit: varchar('unit', { length: 16 }).notNull().default('шт'),
  comment: text('comment'),
  lineNo: integer('line_no').notNull(),
  volumeM3: numeric('volume_m3', { precision: 10, scale: 4 }),
  massKg: numeric('mass_kg', { precision: 10, scale: 3 }),
  volumeConfidence: text('volume_confidence'),
  groupName: text('group_name'),
});

export const deliveryPhotos = pgTable(
  'delivery_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    kind: photoKindEnum('kind').notNull().default('cargo'),
    s3Key: text('s3_key').notNull(),
    thumbS3Key: text('thumb_s3_key'),
    contentHash: varchar('content_hash', { length: 64 }),
    idempotencyKey: uuid('idempotency_key'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('delivery_photo_content_unique')
      .on(t.deliveryId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    uniqueIndex('delivery_photo_idempotency_unique')
      .on(t.deliveryId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

// ─── Shipments (отгрузка) ──────────────────────────────────────────────────

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statusId: uuid('status_id')
      .notNull()
      .references(() => statuses.id),
    kind: shipmentKindEnum('kind').notNull(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    receiverCounterpartyId: uuid('receiver_counterparty_id').references(() => counterparties.id, {
      onDelete: 'set null',
    }),
    destSiteId: uuid('dest_site_id').references(() => sites.id, { onDelete: 'restrict' }),
    vehiclePlate: varchar('vehicle_plate', { length: 16 }),
    driverName: text('driver_name'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    inspectorId: uuid('inspector_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    confirmedByMolUserId: uuid('confirmed_by_mol_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedByMolAt: timestamp('confirmed_by_mol_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipment_site_updated_idx').on(t.siteId, t.updatedAt),
    index('shipment_kind_idx').on(t.kind),
    index('shipment_inspector_idx').on(t.inspectorId),
    index('shipment_dest_site_idx')
      .on(t.destSiteId)
      .where(sql`${t.kind} = 'transfer'`),
    index('shipment_receiver_idx')
      .on(t.receiverCounterpartyId)
      .where(sql`${t.receiverCounterpartyId} is not null`),
    check(
      'shipments_kind_links_chk',
      sql`(
        (${t.kind} = 'contractor' AND ${t.receiverCounterpartyId} IS NOT NULL AND ${t.destSiteId} IS NULL)
        OR (${t.kind} = 'return'    AND ${t.receiverCounterpartyId} IS NOT NULL AND ${t.destSiteId} IS NULL)
        OR (${t.kind} = 'transfer'  AND ${t.receiverCounterpartyId} IS NULL     AND ${t.destSiteId} IS NOT NULL AND ${t.destSiteId} <> ${t.siteId})
        OR (${t.kind} = 'writeoff'  AND ${t.receiverCounterpartyId} IS NULL     AND ${t.destSiteId} IS NULL)
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
  (t) => [primaryKey({ columns: [t.shipmentId, t.sourceDocumentId] })],
);

export const shipmentItems = pgTable(
  'shipment_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    materialId: uuid('material_id').references(() => materials.id, { onDelete: 'set null' }),
    nameRaw: text('name_raw').notNull(),
    qtyPlanned: numeric('qty_planned', { precision: 18, scale: 4 }),
    qtyActual: numeric('qty_actual', { precision: 18, scale: 4 }),
    unit: varchar('unit', { length: 16 }).notNull().default('шт'),
    comment: text('comment'),
    lineNo: integer('line_no').notNull(),
    volumeM3: numeric('volume_m3', { precision: 10, scale: 4 }),
    massKg: numeric('mass_kg', { precision: 10, scale: 3 }),
    volumeConfidence: text('volume_confidence'),
    groupName: text('group_name'),
  },
  (t) => [index('shipment_items_material_idx').on(t.materialId)],
);

export const shipmentPhotos = pgTable(
  'shipment_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    kind: photoKindEnum('kind').notNull().default('cargo'),
    s3Key: text('s3_key').notNull(),
    thumbS3Key: text('thumb_s3_key'),
    contentHash: varchar('content_hash', { length: 64 }),
    idempotencyKey: uuid('idempotency_key'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipment_photo_content_unique')
      .on(t.shipmentId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
    uniqueIndex('shipment_photo_idempotency_unique')
      .on(t.shipmentId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
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
