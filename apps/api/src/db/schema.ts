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

// ─── Enums ─────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'manager', 'inspector_kpp']);
export const sourceKindEnum = pgEnum('source_kind', ['upd', 'request']);
export const sourceOriginEnum = pgEnum('source_origin', [
  'edo_diadoc',
  'manual_xml',
  'manual_pdf',
  'mail',
]);
export const sourceStatusEnum = pgEnum('source_status', ['parsed', 'parse_failed', 'archived']);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'draft',
  'expected',
  'arrived',
  'verified',
  'rejected',
]);
export const photoKindEnum = pgEnum('photo_kind', ['document', 'cargo', 'vehicle', 'other']);
export const llmKindEnum = pgEnum('llm_kind', [
  'openrouter',
  'google_ai_studio',
  'qwen_self_hosted',
  'vertex',
]);
export const attachmentRoleEnum = pgEnum('attachment_role', ['original', 'extracted_text']);

// ─── Auth ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('manager'),
    isActive: boolean('is_active').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sessionsInvalidatedAt: timestamp('sessions_invalidated_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
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
    isCarrier: boolean('is_carrier').notNull().default(false),
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
    index('counterparty_carrier_idx')
      .on(t.name)
      .where(sql`${t.isCarrier}`),
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
  apiBaseUrl: text('api_base_url').notNull(),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  temperature: numeric('temperature', { precision: 4, scale: 2 }).notNull().default('0.2'),
  maxTokens: integer('max_tokens').notNull().default(4096),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Source documents (UPD + Requests) ─────────────────────────────────────

export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: sourceKindEnum('kind').notNull(),
    status: sourceStatusEnum('status').notNull().default('parsed'),
    supplierId: uuid('supplier_id').references(() => counterparties.id, { onDelete: 'set null' }),
    recipientId: uuid('recipient_id').references(() => counterparties.id, { onDelete: 'set null' }),
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
    check(
      'source_upd_required',
      sql`(${t.kind} <> 'upd') or (${t.docNumber} is not null and ${t.docDate} is not null and ${t.totalSum} is not null)`,
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

// ─── Deliveries ────────────────────────────────────────────────────────────

export const deliveries = pgTable('deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: deliveryStatusEnum('status').notNull().default('expected'),
  supplierId: uuid('supplier_id').references(() => counterparties.id, { onDelete: 'set null' }),
  vehiclePlate: varchar('vehicle_plate', { length: 16 }),
  driverName: text('driver_name'),
  arrivedAt: timestamp('arrived_at', { withTimezone: true }),
  inspectorId: uuid('inspector_id').references(() => users.id, { onDelete: 'set null' }),
  comment: text('comment'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
