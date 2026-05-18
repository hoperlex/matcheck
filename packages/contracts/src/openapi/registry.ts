/**
 * OpenAPI 3.1 registry для matcheck Mobile API.
 *
 * Регистрирует схемы и пути, нужные мобильному клиенту «Приёмка»
 * (17 операций, см. docs/MOBILE_API.md). Источник правды — Zod-схемы
 * из packages/contracts/src/*. Артефакт генерируется скриптом
 * scripts/gen-openapi.ts.
 *
 * Convention: каждая схема, попадающая в `components.schemas`,
 * прокидывается через `registry.register('Name', Schema)`, и в
 * путях используется именно возвращаемое значение — иначе библиотека
 * инлайнит схему вместо $ref и Redocly ругается на unused components.
 */
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

import {
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshResponseSchema,
  UserDtoSchema,
  UserRoleSchema,
  ErrorResponseSchema,
} from '../auth.js';
import {
  DeliverySchema,
  DeliveryItemSchema,
  DeliveryPhotoSchema,
  DeliveryUpsertSchema,
  DeliveryListResponseSchema,
  DeliveryMarkDeletionSchema,
  ConflictResponseSchema,
} from '../deliveries.js';
import {
  ShipmentSchema,
  ShipmentItemSchema,
  ShipmentPhotoSchema,
  ShipmentKindSchema,
  ShipmentUpsertSchema,
  ShipmentListResponseSchema,
  ShipmentMarkDeletionSchema,
  ShipmentConflictResponseSchema,
} from '../shipments.js';
import {
  SourceDocumentSchema,
  SourceDocumentDetailSchema,
  SourceDocumentListResponseSchema,
  SourceDocumentFileResponseSchema,
  SourceItemSchema,
  SourceAttachmentSchema,
  SourceKindSchema,
  SourceOriginSchema,
  SourceStatusSchema,
} from '../source-documents.js';
import {
  PhotoPresignRequestSchema,
  PhotoPresignResponseSchema,
  PhotoGetUrlResponseSchema,
  PhotoDeleteResponseSchema,
  PhotoConfirmResponseSchema,
  PhotoKindSchema,
} from '../photos.js';
import { SyncDeltaResponseSchema, SyncDeletedIdsSchema, SseEventSchema } from '../sync.js';
import {
  CounterpartySchema,
  CounterpartyListResponseSchema,
} from '../counterparties.js';
import { MaterialSchema, MaterialListResponseSchema } from '../materials.js';
import { SiteSchema } from '../sites.js';
import {
  StatusSchema,
  StatusListResponseSchema,
  DeliveryStatusCodeSchema,
  ShipmentStatusCodeSchema,
} from '../statuses.js';

export const registry = new OpenAPIRegistry();

// ────────── Security scheme ──────────

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Ed25519 JWT access-token, полученный из POST /auth/login или /auth/refresh. ' +
    'TTL 900 сек, обновляется через /auth/refresh.',
});

// ────────── Регистрация схем (возвращают referenced-объекты) ──────────

const UserRole = registry.register('UserRole', UserRoleSchema);
const UserDto = registry.register('UserDto', UserDtoSchema);
const ErrorResponse = registry.register('ErrorResponse', ErrorResponseSchema);
const LoginRequest = registry.register('LoginRequest', LoginRequestSchema);
const LoginResponse = registry.register('LoginResponse', LoginResponseSchema);
const RefreshResponse = registry.register('RefreshResponse', RefreshResponseSchema);

const DeliveryStatusCode = registry.register('DeliveryStatusCode', DeliveryStatusCodeSchema);
const ShipmentStatusCode = registry.register('ShipmentStatusCode', ShipmentStatusCodeSchema);
const Status = registry.register('Status', StatusSchema);
const StatusListResponse = registry.register('StatusListResponse', StatusListResponseSchema);
const DeliveryItem = registry.register('DeliveryItem', DeliveryItemSchema);
const DeliveryPhoto = registry.register('DeliveryPhoto', DeliveryPhotoSchema);
const Delivery = registry.register('Delivery', DeliverySchema);
const DeliveryUpsert = registry.register('DeliveryUpsert', DeliveryUpsertSchema);
const DeliveryListResponse = registry.register('DeliveryListResponse', DeliveryListResponseSchema);
const DeliveryMarkDeletion = registry.register('DeliveryMarkDeletion', DeliveryMarkDeletionSchema);
const ConflictResponse = registry.register('ConflictResponse', ConflictResponseSchema);

const ShipmentKind = registry.register('ShipmentKind', ShipmentKindSchema);
const ShipmentItem = registry.register('ShipmentItem', ShipmentItemSchema);
const ShipmentPhoto = registry.register('ShipmentPhoto', ShipmentPhotoSchema);
const Shipment = registry.register('Shipment', ShipmentSchema);
const ShipmentUpsert = registry.register('ShipmentUpsert', ShipmentUpsertSchema);
const ShipmentListResponse = registry.register('ShipmentListResponse', ShipmentListResponseSchema);
const ShipmentMarkDeletion = registry.register('ShipmentMarkDeletion', ShipmentMarkDeletionSchema);
const ShipmentConflictResponse = registry.register(
  'ShipmentConflictResponse',
  ShipmentConflictResponseSchema,
);

const SourceKind = registry.register('SourceKind', SourceKindSchema);
const SourceOrigin = registry.register('SourceOrigin', SourceOriginSchema);
const SourceStatus = registry.register('SourceStatus', SourceStatusSchema);
const SourceItem = registry.register('SourceItem', SourceItemSchema);
const SourceAttachment = registry.register('SourceAttachment', SourceAttachmentSchema);
const SourceDocument = registry.register('SourceDocument', SourceDocumentSchema);
const SourceDocumentDetail = registry.register('SourceDocumentDetail', SourceDocumentDetailSchema);
const SourceDocumentListResponse = registry.register(
  'SourceDocumentListResponse',
  SourceDocumentListResponseSchema,
);
const SourceDocumentFileResponse = registry.register(
  'SourceDocumentFileResponse',
  SourceDocumentFileResponseSchema,
);

const PhotoKind = registry.register('PhotoKind', PhotoKindSchema);
const PhotoPresignRequest = registry.register('PhotoPresignRequest', PhotoPresignRequestSchema);
const PhotoPresignResponse = registry.register('PhotoPresignResponse', PhotoPresignResponseSchema);
const PhotoGetUrlResponse = registry.register('PhotoGetUrlResponse', PhotoGetUrlResponseSchema);
const PhotoDeleteResponse = registry.register('PhotoDeleteResponse', PhotoDeleteResponseSchema);
const PhotoConfirmResponse = registry.register('PhotoConfirmResponse', PhotoConfirmResponseSchema);

const Counterparty = registry.register('Counterparty', CounterpartySchema);
const CounterpartyListResponse = registry.register(
  'CounterpartyListResponse',
  CounterpartyListResponseSchema,
);

const Material = registry.register('Material', MaterialSchema);
const MaterialListResponse = registry.register('MaterialListResponse', MaterialListResponseSchema);

const Site = registry.register('Site', SiteSchema);

const SyncDeletedIds = registry.register('SyncDeletedIds', SyncDeletedIdsSchema);
const SyncDeltaResponse = registry.register('SyncDeltaResponse', SyncDeltaResponseSchema);
const SseEvent = registry.register('SseEvent', SseEventSchema);

// Помечаем "случайно неиспользованные" регистрации (нужны как компоненты,
// но не обязательно ссылаются из путей — Kotlin-генератор может их использовать).
void UserRole;
void DeliveryStatusCode;
void ShipmentStatusCode;
void Status;
void DeliveryItem;
void DeliveryPhoto;
void ShipmentKind;
void ShipmentItem;
void ShipmentPhoto;
void SourceKind;
void SourceOrigin;
void SourceStatus;
void SourceItem;
void SourceAttachment;
void PhotoKind;
void Counterparty;
void Material;
void Site;
void SourceDocument;
void SyncDeletedIds;

// ────────── Хелперы ──────────

const bearer = [{ bearerAuth: [] }];
const noAuth: Array<Record<string, string[]>> = [];

const errResp = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponse } },
});

const errorRefs = {
  401: errResp('Не авторизовано'),
  403: errResp('Доступ запрещён (недостаточно прав)'),
  429: errResp('Превышен rate-limit'),
} as const;

const clientTypeHeader = z.object({
  'x-client-type': z
    .literal('mobile')
    .optional()
    .openapi({
      description:
        'Установить значение `mobile` для нативных клиентов. В этом случае refresh-token возвращается в теле ответа, а cookies не устанавливаются.',
    }),
});

// ────────── 1. Auth ──────────

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/login',
  tags: ['Auth'],
  summary: 'Вход по email/паролю',
  description:
    'Возвращает access-token (Ed25519 JWT, TTL 900 сек). Для мобильных клиентов ' +
    'с заголовком `X-Client-Type: mobile` дополнительно возвращает `refreshToken` и `refreshExpiresIn` в теле ответа; ' +
    'для веб-клиентов refresh-token устанавливается в HttpOnly-cookie `__Host-refresh`.',
  security: noAuth,
  request: {
    headers: clientTypeHeader,
    body: {
      content: { 'application/json': { schema: LoginRequest } },
    },
  },
  responses: {
    200: {
      description: 'Успешный вход',
      content: { 'application/json': { schema: LoginResponse } },
    },
    401: errResp('Неверные учётные данные или аккаунт неактивен'),
    423: errResp('Аккаунт временно заблокирован'),
    429: errorRefs[429],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/refresh',
  tags: ['Auth'],
  summary: 'Обновить access-token',
  description:
    'Принимает refresh-token из HttpOnly-cookie `__Host-refresh` (веб) ' +
    'либо из заголовка `Authorization: Bearer <refreshToken>` при `X-Client-Type: mobile`. ' +
    'Реализует rotation: старый refresh-token инвалидируется, выдаётся новый. ' +
    'Reuse уже использованного refresh → 401 + полная инвалидация сессии.',
  security: noAuth,
  request: {
    headers: clientTypeHeader,
  },
  responses: {
    200: {
      description: 'Новый access-token (+ refresh-token в теле для mobile)',
      content: { 'application/json': { schema: RefreshResponse } },
    },
    401: errResp('Refresh-token отсутствует, истёк или инвалидирован'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/auth/logout',
  tags: ['Auth'],
  summary: 'Завершить сессию',
  security: bearer,
  responses: {
    200: {
      description: 'Сессия инвалидирована',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/auth/me',
  tags: ['Auth'],
  summary: 'Профиль текущего пользователя',
  security: bearer,
  responses: {
    200: {
      description: 'Профиль',
      content: { 'application/json': { schema: UserDto } },
    },
    401: errorRefs[401],
  },
});

// ────────── 2. Sync ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/sync',
  tags: ['Sync'],
  summary: 'Дельта-синхронизация',
  description:
    'Возвращает все объекты с updatedAt >= since. Limits на запрос: 500 counterparties, ' +
    '500 materials, 200 sourceDocuments, 500 deliveries, 500 shipments. Если данных больше — ' +
    'повторно вызвать /sync с новым cursor. Inspector_kpp видит данные своего объекта (по siteId). ' +
    'При initial-sync (since=null) рекомендуется задать windowDays для ограничения окна выдачи; ' +
    'при дельта-sync окно не применяется (старые записи могли поменяться). Поле deletedIds ' +
    'возвращается только при дельта-sync — содержит id записей, окончательно удалённых после since.',
  security: bearer,
  request: {
    query: z.object({
      since: z
        .string()
        .optional()
        .openapi({
          description: 'ISO-8601 timestamp. Если не указан — initial-sync, окно ограничивается windowDays.',
          example: '2026-05-14T10:00:00Z',
        }),
      windowDays: z
        .coerce.number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .openapi({
          description:
            'Окно (в днях) для initial-sync: deliveries/shipments/sourceDocuments отдаются за последние N дней. ' +
            'Default 90. Применяется только при since=null; при дельта-sync игнорируется.',
          example: 90,
        }),
    }),
  },
  responses: {
    200: {
      description: 'Дельта изменений',
      content: { 'application/json': { schema: SyncDeltaResponse } },
    },
    401: errorRefs[401],
  },
});

// ────────── 3. SSE Events ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/events',
  tags: ['Sync'],
  summary: 'SSE-поток invalidation-событий',
  description:
    'Server-Sent Events. Auth через Bearer-header или cookie `__Host-access`. ' +
    'Ping каждые 25 сек. При получении события `delivery_updated`/`source_document_updated`/и т.п. ' +
    'клиент должен вызвать GET /sync. Реализация на Kotlin: okhttp-sse (поддерживает Authorization).',
  security: bearer,
  responses: {
    200: {
      description: 'Поток событий (text/event-stream)',
      content: {
        'text/event-stream': {
          schema: SseEvent,
        },
      },
    },
    401: errorRefs[401],
  },
});

// ────────── 4. Source documents (УПД) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/source-documents',
  tags: ['SourceDocuments'],
  summary: 'Список УПД (входящих документов)',
  security: bearer,
  request: {
    query: z.object({
      kind: SourceKindSchema.optional().openapi({ description: 'Тип документа' }),
      unaccepted: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'Только неподтверждённые УПД (без привязки к приёмке)' }),
      q: z.string().optional().openapi({ description: 'Поиск по номеру/контрагенту' }),
      limit: z.coerce.number().int().min(1).max(500).optional().openapi({ example: 100 }),
      offset: z.coerce.number().int().min(0).optional().openapi({ example: 0 }),
    }),
  },
  responses: {
    200: {
      description: 'Список УПД',
      content: { 'application/json': { schema: SourceDocumentListResponse } },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/source-documents/{id}',
  tags: ['SourceDocuments'],
  summary: 'Детали УПД (с позициями и вложениями)',
  security: bearer,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'УПД с позициями',
      content: { 'application/json': { schema: SourceDocumentDetail } },
    },
    401: errorRefs[401],
    404: errResp('Документ не найден'),
  },
});

// ────────── 5. Deliveries (Приёмки) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/deliveries',
  tags: ['Deliveries'],
  summary: 'Список приёмок',
  description:
    'Inspector_kpp видит приёмки своего объекта (по siteId), включая записи других инспекторов. ' +
    'Manager/admin — все. Поддерживает дельта-выборку через changedSince. По умолчанию скрывает ' +
    'помеченные на удаление; trash=true показывает только их (корзина).',
  security: bearer,
  request: {
    query: z.object({
      status: DeliveryStatusCodeSchema.optional(),
      inspectorId: z.string().uuid().optional(),
      changedSince: z.string().optional().openapi({ description: 'ISO-8601' }),
      trash: z
        .coerce.boolean()
        .optional()
        .openapi({
          description: 'false/unset — активные документы; true — корзина (pending_deletion).',
        }),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Список приёмок',
      content: { 'application/json': { schema: DeliveryListResponse } },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/deliveries/{id}',
  tags: ['Deliveries'],
  summary: 'Детали приёмки',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Приёмка',
      content: { 'application/json': { schema: Delivery } },
    },
    401: errorRefs[401],
    404: errResp('Приёмка не найдена'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/deliveries',
  tags: ['Deliveries'],
  summary: 'Создать или обновить приёмку (upsert)',
  description:
    'OCC через `baseVersion`. Если версия на сервере отличается — 409 `conflict` с серверным snapshot. ' +
    'Клиент показывает UI разрешения (server_win / local_win / merge) и повторяет POST с новым baseVersion. ' +
    'Если документ помечен на удаление (pendingDeletionAt != null) — 409 `pending_deletion`, любые мутации запрещены до unmark-deletion.',
  security: bearer,
  request: {
    body: {
      content: { 'application/json': { schema: DeliveryUpsert } },
    },
  },
  responses: {
    200: {
      description: 'Создана/обновлена',
      content: { 'application/json': { schema: Delivery } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    409: {
      description: 'Конфликт версии (conflict) или документ помечен на удаление (pending_deletion)',
      content: { 'application/json': { schema: ConflictResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/deliveries/{id}',
  tags: ['Deliveries'],
  summary: 'Удалить приёмку',
  description:
    'Двухэтапная модель удаления:\n' +
    '- `draft`/`not_filled` — hard-delete. Inspector_kpp может удалить приёмку своего siteId; manager/admin — любые.\n' +
    '- `filled`/`confirmed_mol` — сначала POST /mark-deletion; иначе 409 `must_mark_first`. ' +
    'Окончательное удаление помеченного документа доступно только admin.\n' +
    'При hard-delete пишется запись в журнал удалений → офлайн-клиент видит её в `/sync.deletedIds`.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Удалена',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Приёмка не найдена'),
    409: errResp('Требуется пометка на удаление (must_mark_first)'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/deliveries/{id}/mark-deletion',
  tags: ['Deliveries'],
  summary: 'Пометить приёмку на удаление',
  description:
    'Применимо только к статусам `filled`/`confirmed_mol`. Документ становится read-only: ' +
    'все мутации (upsert, фото) отвечают 409 `pending_deletion`. ' +
    'Окончательное удаление выполняет admin с портала через DELETE.',
  security: bearer,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: DeliveryMarkDeletion } } },
  },
  responses: {
    200: {
      description: 'Помечена на удаление',
      content: { 'application/json': { schema: Delivery } },
    },
    400: errResp('cannot_mark_status — статус не позволяет пометку'),
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Приёмка не найдена'),
    409: errResp('already_pending — уже помечена'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/deliveries/{id}/unmark-deletion',
  tags: ['Deliveries'],
  summary: 'Снять пометку об удалении',
  description:
    'Доступ: автор пометки или admin. Inspector_kpp ограничен своим siteId.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Пометка снята',
      content: { 'application/json': { schema: Delivery } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Приёмка не найдена'),
    409: errResp('not_pending — документ не помечен на удаление'),
  },
});

// ────────── 6. Counterparties / Materials (справочники) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/counterparties',
  tags: ['References'],
  summary: 'Справочник контрагентов',
  security: bearer,
  request: {
    query: z.object({
      role: z.enum(['supplier', 'customer', 'contractor']).optional(),
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Список контрагентов',
      content: { 'application/json': { schema: CounterpartyListResponse } },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/materials',
  tags: ['References'],
  summary: 'Справочник материалов',
  security: bearer,
  request: {
    query: z.object({
      q: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Список материалов',
      content: { 'application/json': { schema: MaterialListResponse } },
    },
    401: errorRefs[401],
  },
});

// ────────── 7. Photos ──────────

registry.registerPath({
  method: 'post',
  path: '/api/v1/photos/presign',
  tags: ['Photos'],
  summary: 'Получить presigned PUT-URL для загрузки фото в S3',
  description:
    'Двухэтапный pipeline: клиент сжимает фото, считает SHA-256 → presign → PUT в S3. ' +
    'Дедупликация по contentHash — если фото уже существует, возвращается alreadyExists=true ' +
    'и клиент пропускает PUT. TTL presigned URL: 300 сек.',
  security: bearer,
  request: {
    body: {
      content: { 'application/json': { schema: PhotoPresignRequest } },
    },
  },
  responses: {
    200: {
      description: 'Presigned URL выдан (или alreadyExists=true)',
      content: { 'application/json': { schema: PhotoPresignResponse } },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/photos/{id}/confirm',
  tags: ['Photos'],
  summary: 'Подтвердить успешную загрузку фото в S3',
  description:
    'Клиент вызывает после успешного PUT в S3. Сервер делает S3.HEAD и, если объект ' +
    'существует, проставляет `uploaded_at = now()`. Это защищает запись от cleanup-job ' +
    'orphan-записей. Idempotent: повторный вызов возвращает прежний uploaded_at. ' +
    'Inspector_kpp может подтвердить только фото своего объекта (по siteId).',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Подтверждено',
      content: { 'application/json': { schema: PhotoConfirmResponse } },
    },
    401: errorRefs[401],
    404: errResp('Фото не найдено или ещё не загружено в S3 (not_in_s3)'),
    500: errResp('S3 недоступна (s3_unavailable) — повторить позже'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/photos/{id}/url',
  tags: ['Photos'],
  summary: 'Получить presigned GET-URL для просмотра фото',
  security: bearer,
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      thumb: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'Если true — возвращается URL для thumbnail' }),
    }),
  },
  responses: {
    200: {
      description: 'Presigned URL',
      content: { 'application/json': { schema: PhotoGetUrlResponse } },
    },
    401: errorRefs[401],
    404: errResp('Фото не найдено'),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/photos/{id}',
  tags: ['Photos'],
  summary: 'Удалить фото (только admin)',
  description:
    'Удаляет запись из delivery_photos и связанные объекты в S3 (основной + thumb). ' +
    'Доступно только пользователям с ролью admin. Ошибки S3 не валят запрос — логируются. ' +
    'Если родительский документ помечен на удаление — 409 `pending_deletion`.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Фото удалено',
      content: { 'application/json': { schema: PhotoDeleteResponse } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Фото не найдено'),
    409: errResp('Родительский документ помечен на удаление'),
  },
});

// ────────── 8. Shipments (Отгрузки) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/shipments',
  tags: ['Shipments'],
  summary: 'Список отгрузок',
  description:
    'Inspector_kpp видит отгрузки своего объекта (по siteId). Manager/admin — все. ' +
    'По умолчанию скрывает помеченные на удаление; trash=true показывает корзину.',
  security: bearer,
  request: {
    query: z.object({
      status: ShipmentStatusCodeSchema.optional(),
      kind: ShipmentKindSchema.optional(),
      siteId: z.string().uuid().optional().openapi({
        description: 'Для manager/admin. Inspector_kpp игнорируется — сервер всегда использует свой siteId.',
      }),
      inspectorId: z.string().uuid().optional(),
      changedSince: z.string().optional().openapi({ description: 'ISO-8601' }),
      trash: z.coerce.boolean().optional().openapi({
        description: 'false/unset — активные документы; true — корзина.',
      }),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Список отгрузок',
      content: { 'application/json': { schema: ShipmentListResponse } },
    },
    401: errorRefs[401],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/shipments/{id}',
  tags: ['Shipments'],
  summary: 'Детали отгрузки',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Отгрузка',
      content: { 'application/json': { schema: Shipment } },
    },
    401: errorRefs[401],
    404: errResp('Отгрузка не найдена'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/shipments',
  tags: ['Shipments'],
  summary: 'Создать или обновить отгрузку (upsert)',
  description:
    'OCC через `baseVersion`. На несовпадение версии — 409 `conflict` с серверным snapshot. ' +
    'Если документ помечен на удаление — 409 `pending_deletion`. ' +
    'Валидация по kind: contractor/return требуют receiverCounterpartyId; transfer — destSiteId ≠ siteId; writeoff — без получателя.',
  security: bearer,
  request: {
    body: { content: { 'application/json': { schema: ShipmentUpsert } } },
  },
  responses: {
    200: {
      description: 'Создана/обновлена',
      content: { 'application/json': { schema: Shipment } },
    },
    400: errResp('Невалидные ссылки kind ↔ receiver/destSite'),
    401: errorRefs[401],
    403: errorRefs[403],
    409: {
      description: 'Конфликт версии (conflict) или документ помечен на удаление (pending_deletion)',
      content: { 'application/json': { schema: ShipmentConflictResponse } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/shipments/{id}',
  tags: ['Shipments'],
  summary: 'Удалить отгрузку',
  description:
    'Двухэтапная модель, аналогично deliveries:\n' +
    '- `draft`/`not_filled` — hard-delete. Inspector_kpp в рамках своего siteId; manager/admin — любые.\n' +
    '- `shipped`/`confirmed_mol` — сначала POST /mark-deletion; иначе 409 `must_mark_first`. ' +
    'Окончательное удаление помеченной отгрузки — только admin.\n' +
    'При hard-delete пишется запись в журнал удалений → офлайн-клиент видит её в `/sync.deletedIds`.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Удалена',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Отгрузка не найдена'),
    409: errResp('Требуется пометка на удаление (must_mark_first)'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/shipments/{id}/mark-deletion',
  tags: ['Shipments'],
  summary: 'Пометить отгрузку на удаление',
  description:
    'Применимо только к статусам `shipped`/`confirmed_mol`. Документ становится read-only. ' +
    'Окончательное удаление выполняет admin через DELETE.',
  security: bearer,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { 'application/json': { schema: ShipmentMarkDeletion } } },
  },
  responses: {
    200: {
      description: 'Помечена на удаление',
      content: { 'application/json': { schema: Shipment } },
    },
    400: errResp('cannot_mark_status — статус не позволяет пометку'),
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Отгрузка не найдена'),
    409: errResp('already_pending — уже помечена'),
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/shipments/{id}/unmark-deletion',
  tags: ['Shipments'],
  summary: 'Снять пометку об удалении',
  description: 'Доступ: автор пометки или admin. Inspector_kpp ограничен своим siteId.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Пометка снята',
      content: { 'application/json': { schema: Shipment } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Отгрузка не найдена'),
    409: errResp('not_pending — документ не помечен на удаление'),
  },
});

// ────────── 9. Source document file (скачивание оригинала) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/source-documents/{id}/file',
  tags: ['SourceDocuments'],
  summary: 'Получить presigned URL для скачивания оригинала УПД',
  description:
    'Возвращает presigned GET-URL на оригинальный PDF/XML документа в S3, имя файла и MIME. ' +
    'TTL URL — 3600 сек. Inspector_kpp может скачивать только документы своего siteId.',
  security: bearer,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Presigned URL и метаданные файла',
      content: { 'application/json': { schema: SourceDocumentFileResponse } },
    },
    401: errorRefs[401],
    403: errorRefs[403],
    404: errResp('Документ или файл не найден'),
  },
});

// ────────── 10. Statuses (справочник статусов) ──────────

registry.registerPath({
  method: 'get',
  path: '/api/v1/statuses',
  tags: ['References'],
  summary: 'Справочник статусов (по типу сущности)',
  description:
    'Возвращает все статусы для указанного entityType: code, label, color, sortOrder. ' +
    'Если entityType не задан — все статусы (delivery + shipment + …).',
  security: bearer,
  request: {
    query: z.object({
      entityType: z.string().optional().openapi({
        description: 'Например, `delivery` или `shipment`.',
        example: 'delivery',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Список статусов',
      content: { 'application/json': { schema: StatusListResponse } },
    },
    401: errorRefs[401],
  },
});
