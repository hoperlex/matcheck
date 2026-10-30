import { z } from 'zod';
import { decimalString } from './decimal-string.js';
import { DeliveryStatusCodeSchema, StatusSchema } from './statuses.js';
import {
  VolumeConfidenceSchema,
  PrimarySourceDocumentSchema,
  OperationSourceDocumentSchema,
} from './source-documents.js';
import { DispatcherCheckFieldsShape, ReviewFieldsShape } from './review.js';
import { GroupOperationFields } from './group-operations.js';

export const ItemKindSchema = z.enum(['material', 'asset']);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const DeliveryItemSchema = z.object({
  id: z.string().uuid(),
  /**
   * Происхождение позиции: документ, из которого она приехала. НЕ «текущая
   * связь» — связь приёмки с документом живёт в sourceDocumentIds и снимается
   * отвязкой, а происхождение остаётся. По нему строятся секции «УПД № … ·
   * Материалы (N)» и проверка «эта строка действительно из этого документа».
   *
   * null — происхождение неизвестно: строка внесена руками либо это история до
   * миграции 0096, которую не удалось сопоставить однозначно. «Без привязки к
   * УПД», а не «добавлено вручную»: утверждать второе мы не можем.
   *
   * optional — схема общая с /sync и ответами upsert; продюсеры, которые поле
   * не собирают, не должны падать на валидации ответа.
   */
  sourceDocumentId: z.string().uuid().nullable().optional(),
  /** Конкретная строка документа-источника; null после его переразбора. */
  sourceDocumentItemId: z.string().uuid().nullable().optional(),
  itemKind: ItemKindSchema,
  materialId: z.string().uuid().nullable(),
  assetId: z.string().uuid().nullable(),
  inventoryNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  nameRaw: z.string(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  unit: z.string(),
  comment: z.string().nullable(),
  lineNo: z.number(),
  volumeM3: z.string().nullable(),
  massKg: z.string().nullable(),
  // Финансовый снимок позиции из УПД: цена за единицу, ставка НДС (%),
  // сумма НДС. price/vatRate подтягиваются один раз при создании
  // приёмки из УПД; vatSum пересчитывается клиентом из qtyActual×price×vatRate
  // и приходит на сервер уже пересчитанным.
  price: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
});
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

// Этап приёмки, к которому относится фото. Проставляет мобильный клиент
// при загрузке: 'before' — фото 1-го этапа (КПП/осмотр), 'after' — фото
// 2-го этапа (после выгрузки и подтверждения МОЛ). Default 'before'
// для совместимости с клиентами, не присылающими поле.
export const DeliveryPhotoStageSchema = z.enum(['before', 'after']);
export type DeliveryPhotoStage = z.infer<typeof DeliveryPhotoStageSchema>;

export const DeliveryPhotoSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['document', 'cargo', 'vehicle', 'other']),
  stage: DeliveryPhotoStageSchema.default('before'),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  contentHash: z.string().nullable(),
  takenAt: z.string(),
  // null = orphan-запись (PUT в S3 не подтверждён). Клиент не должен пытаться
  // открыть такое фото — через час оно либо подтвердится cleanup-job'ом, либо
  // удалится.
  uploadedAt: z.string().nullable(),
});
export type DeliveryPhoto = z.infer<typeof DeliveryPhotoSchema>;

/** Назначение приёмки, выбираемое в веб-карточке. */
export const DeliveryPurposeSchema = z.enum([
  'own_forces',
  'realization',
  'tolling_act',
  'contractor_materials',
  'realization_tolling',
]);
export type DeliveryPurpose = z.infer<typeof DeliveryPurposeSchema>;

/** Подписи признака — общие для карточки, списка и выгрузки Excel. */
export const DELIVERY_PURPOSE_LABELS: Record<DeliveryPurpose, string> = {
  own_forces: 'Свои силы',
  realization: 'Реализация',
  tolling_act: 'Давальческий акт',
  contractor_materials: 'Материалы подрядчика',
  realization_tolling: 'Реализация + давальческий',
};

/** Вид получателя приёмки: подрядчик (contractor_id), МОЛ (recipient_mol_id) или никто. */
export type DeliveryRecipientKind = 'contractor' | 'mol' | null;

export function deliveryRecipientKind(r: {
  contractorId: string | null;
  recipientMolId: string | null;
}): DeliveryRecipientKind {
  if (r.recipientMolId) return 'mol';
  if (r.contractorId) return 'contractor';
  return null;
}

/**
 * Какие признаки допустимы при данном получателе. «Свои силы» — работа своей
 * бригады, у подрядчика его не бывает; при МОЛ и без получателя доступно всё.
 */
export function allowedDeliveryPurposes(kind: DeliveryRecipientKind): DeliveryPurpose[] {
  const all = DeliveryPurposeSchema.options;
  return kind === 'contractor' ? all.filter((p) => p !== 'own_forces') : [...all];
}

/**
 * Признак после записи получателя. Единственная реализация правила: её зовут
 * и сервер (под блокировкой строки приёмки), и карточка — для подсказки, каким
 * признак станет после «Сохранить».
 *   - получатель стал МОЛ, а до этого МОЛ не был → «Свои силы» (дальше
 *     человек может сменить; смена одного МОЛ на другого выбор не сбрасывает);
 *   - получатель — подрядчик, а признак «Свои силы» → признак не выбран;
 *   - иначе признак прежний.
 */
export function reconcileDeliveryPurpose(
  prevKind: DeliveryRecipientKind,
  nextKind: DeliveryRecipientKind,
  purpose: DeliveryPurpose | null,
): DeliveryPurpose | null {
  if (nextKind === 'mol' && prevKind !== 'mol') return 'own_forces';
  if (nextKind === 'contractor' && purpose === 'own_forces') return null;
  return purpose;
}

/** Независимое наследование получателя и признака у связанного документа. */
export type DocumentRecipientState = {
  ownRecipient: boolean;
  contractorId: string | null;
  recipientMolId: string | null;
  ownPurpose: boolean;
  purpose: DeliveryPurpose | null;
};

export function effectiveDocumentRecipient(
  general: {
    contractorId: string | null;
    recipientMolId: string | null;
    purpose: DeliveryPurpose | null;
  },
  doc: DocumentRecipientState,
) {
  return {
    contractorId: doc.ownRecipient ? doc.contractorId : general.contractorId,
    recipientMolId: doc.ownRecipient ? doc.recipientMolId : general.recipientMolId,
    purpose: doc.ownPurpose ? doc.purpose : general.purpose,
  };
}

/**
 * Исправляет только вынужденный конфликт после смены получателя или общего
 * признака. Явный NULL собственного признака остаётся собственным NULL.
 */
export function reconcileDocumentPurpose(
  previousGeneral: {
    contractorId: string | null;
    recipientMolId: string | null;
    purpose: DeliveryPurpose | null;
  },
  nextGeneral: {
    contractorId: string | null;
    recipientMolId: string | null;
    purpose: DeliveryPurpose | null;
  },
  previousDoc: DocumentRecipientState,
  nextDoc: DocumentRecipientState,
): DocumentRecipientState {
  const previousKind = deliveryRecipientKind(
    effectiveDocumentRecipient(previousGeneral, previousDoc),
  );
  const effective = effectiveDocumentRecipient(nextGeneral, nextDoc);
  const nextKind = deliveryRecipientKind(effective);
  if (nextKind === 'mol' && previousKind !== 'mol' && effective.purpose !== 'own_forces') {
    return { ...nextDoc, ownPurpose: true, purpose: 'own_forces' };
  }
  if (nextKind === 'contractor' && effective.purpose === 'own_forces') {
    return { ...nextDoc, ownPurpose: true, purpose: null };
  }
  return nextDoc;
}

export const DocumentRecipientSchema = z.object({
  sourceDocumentId: z.string().uuid(),
  ownRecipient: z.boolean(),
  contractorId: z.string().uuid().nullable(),
  contractorName: z.string().nullable(),
  recipientMolId: z.string().uuid().nullable(),
  recipientMolName: z.string().nullable(),
  ownPurpose: z.boolean(),
  purpose: DeliveryPurposeSchema.nullable(),
});
export type DocumentRecipient = z.infer<typeof DocumentRecipientSchema>;

export const DeliverySchema = z.object({
  id: z.string().uuid(),
  // Короткий человекочитаемый id для столбца «id» в Принятых и
  // заголовка модалки «Приёмка #N». Авто-возрастающий, уникальный.
  displayId: z.number().int().positive(),
  status: StatusSchema,
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable(),
  contractorId: z.string().uuid().nullable(),
  recipientMolId: z.string().uuid().nullable(),
  // Имена объекта/поставщика/подрядчика — резолвятся сервером в DTO, чтобы
  // роль contractor не ходила в закрытые для неё справочники. optional —
  // мобильный клиент их не шлёт при upsert и может не знать (обратная совместимость).
  siteName: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  contractorName: z.string().nullable().optional(),
  recipientMolName: z.string().nullable().optional(),
  vehiclePlate: z.string().nullable(),
  driverName: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  inspectorId: z.string().uuid().nullable(),
  comment: z.string().nullable(),
  /**
   * Транзит — приёмка является частью транзитного рейса (машина
   * разгрузилась и поехала с другим грузом). Чекбокс на 1 этапе мобилы.
   * Default false. См. миграцию 0051.
   */
  inTransit: z.boolean(),
  /**
   * ОС — флаг «основные средства»: накладная относится к движению
   * объектов ОС, а не материалов. Чекбокс на 1 этапе мобилы. Default
   * false. Веб-портал показывает бейдж рядом с «Транзит». См. миграцию 0065.
   */
  isAssets: z.boolean(),
  // null у существующих приёмок, которым признак ещё не назначен.
  // optional сохраняет совместимость старых офлайн-снимков мобильного клиента.
  purpose: DeliveryPurposeSchema.nullable().optional(),
  recipientsPerDocument: z.boolean().optional(),
  documentRecipients: z.array(DocumentRecipientSchema).optional(),
  confirmedByMolUserId: z.string().uuid().nullable(),
  confirmedByMolUserEmail: z.string().nullable(),
  confirmedByMolAt: z.string().nullable(),
  // Отметка проверки (роль «Мониторинг»). Ортогональна статусу. Видна только
  // admin/manager/monitor — для прочих ролей сервер отдаёт их null (см. buildDeliveryDto).
  ...ReviewFieldsShape,
  // Отметка «Диспетчер» — видна тем же ролям, что отметка проверки.
  ...DispatcherCheckFieldsShape,
  pendingDeletionAt: z.string().nullable(),
  pendingDeletionByUserId: z.string().uuid().nullable(),
  pendingDeletionByUserEmail: z.string().nullable(),
  pendingDeletionReason: z.string().nullable(),
  version: z.number(),
  sourceDocumentIds: z.array(z.string().uuid()),
  // Для парных приёмок, созданных из shipment.kind='transfer': указывает
  // на исходный shipment и подтягивает плоские поля исходного объекта/даты
  // отгрузки. Read-only, заполняется сервером.
  sourceShipmentId: z.string().uuid().nullable(),
  sourceShipmentShippedAt: z.string().nullable(),
  sourceShipmentSiteId: z.string().uuid().nullable(),
  sourceShipmentSiteCode: z.string().nullable(),
  items: z.array(DeliveryItemSchema),
  photos: z.array(DeliveryPhotoSchema),
  // ── Волна 1B: аддитивные предподсчёты для списка «Операции». Все optional —
  // обратная совместимость: мобильный клиент (ignoreUnknownKeys) и старый web
  // их игнорируют; заполняет сервер. Списку не нужно итерировать items[] ради
  // сумм, а primarySourceDocument снимает запрос source-documents?limit=1000. ──
  itemCount: z.number().int().nonnegative().optional(),
  photoCount: z.number().int().nonnegative().optional(),
  // Σ qty×price и Σ vatSum по позициям — считает сервер той же формулой, что
  // раньше клиент (deliveryItemsTotal/deliveryItemsVatSum). null = ни у одной
  // позиции нет цены/НДС (UI показывает «—»).
  itemsTotal: z.number().nullable().optional(),
  itemsVatSum: z.number().nullable().optional(),
  primarySourceDocument: PrimarySourceDocumentSchema.nullable().optional(),
  // Все документы приёмки: связанные плюс те, что остались только в
  // происхождении позиций. Карточка строит по ним шапку (номера и суммы —
  // только по linked) и блоки материалов. Optional по той же причине, что и
  // блок выше: /sync поле не собирает, мобильный клиент его игнорирует.
  sourceDocuments: z.array(OperationSourceDocumentSchema).optional(),
  /**
   * Разбор документа нашёл расхождение или подозрение, и операция ещё открыта.
   *
   * Один признак на три места — фильтр очереди, значок в списке и колонку
   * выгрузки. Раньше каждое считало своё, и приёмка с сигналом только от сверки
   * фото попадала в отфильтрованную выдачу, но выглядела там чистой.
   *
   * Опционально: офлайн-снимок `/sync` его не несёт, а мобильный клиент поля
   * не объявляет вовсе.
   */
  docAttention: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const DeliveryMarkDeletionSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});
export type DeliveryMarkDeletion = z.infer<typeof DeliveryMarkDeletionSchema>;

export const DeliveryUpsertItemSchema = z.object({
  id: z.string().uuid().optional(),
  /**
   * Происхождение позиции.
   *
   * `sourceDocumentId` для строки, которая уже есть в приёмке, игнорируется:
   * сервер берёт сохранённое из БД. Клиент не может переписать происхождение
   * задним числом — иначе достаточно одного устаревшего планшета, чтобы
   * приписать позиции чужому документу. Присланный документ, не привязанный к
   * этой приёмке, отбрасывается в null.
   *
   * `sourceDocumentItemId` у существующей строки — идентификатор
   * ВОССТАНОВЛЕНИЯ, а не значение: сервер сопоставляет им строку, чей `id`
   * устарел (см. domain/operations/item-origin.ts, шаг 1.5), и наследует
   * происхождение найденной строки ИЗ БД. Ключ переживает переименование —
   * запасное сопоставление по названию при правке текста промахивается.
   * Присвоить строке чужую атрибуцию этим полем нельзя.
   */
  sourceDocumentId: z.string().uuid().nullable().optional(),
  sourceDocumentItemId: z.string().uuid().nullable().optional(),
  itemKind: ItemKindSchema.default('material'),
  materialId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  inventoryNumber: z.string().max(200).nullable().optional(),
  serialNumber: z.string().max(200).nullable().optional(),
  /**
   * `trim()` не косметика: без него строка из одних пробелов проходит `min(1)`
   * и попадает в БД как «пустое» название. Портал такую строку раньше молча
   * выбрасывал при сохранении — вместе с количеством, ценой и привязкой к
   * документу. Инвариант «у позиции есть непустое имя» должен держать сервер, а
   * не только форма.
   */
  nameRaw: z.string().trim().min(1),
  qtyPlanned: decimalString({ precision: 18, scale: 4 }),
  qtyActual: decimalString({ precision: 18, scale: 4 }),
  unit: z.string().min(1).default('шт'),
  comment: z.string().nullable().optional(),
  lineNo: z.number(),
  volumeM3: decimalString({ precision: 10, scale: 4 }),
  massKg: decimalString({ precision: 10, scale: 3 }),
  price: decimalString({ precision: 18, scale: 4 }),
  vatRate: decimalString({ precision: 5, scale: 2 }),
  vatSum: decimalString({ precision: 18, scale: 2 }),
  volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
  groupName: z.string().nullable().optional(),
});

export const DeliveryUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  statusCode: DeliveryStatusCodeSchema,
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  contractorId: z.string().uuid().nullable().optional(),
  recipientMolId: z.string().uuid().nullable().optional(),
  /** Явный выбор проверяющего вместе с получателем; старые клиенты поле не шлют. */
  purpose: DeliveryPurposeSchema.optional(),
  vehiclePlate: z.string().max(16).nullable().optional(),
  driverName: z.string().max(200).nullable().optional(),
  arrivedAt: z.string().nullable().optional(),
  /**
   * Момент, когда инспектор фактически подтвердил приёмку на планшете
   * (завершил 2 Этап или ручной внос). Опционально: сборки до 1.0.33 его не
   * шлют, для них сервер ставит своё время. Длину ограничиваем — строка
   * приходит с устройства. Разбор и клампы — domain/operations/confirmed-at.ts.
   */
  confirmedByMolAt: z.string().max(64).nullable().optional(),
  comment: z.string().nullable().optional(),
  /** Транзит — см. DeliverySchema.inTransit. Default false. */
  inTransit: z.boolean().default(false),
  /** ОС — см. DeliverySchema.isAssets. Default false. */
  isAssets: z.boolean().default(false),
  sourceDocumentIds: z.array(z.string().uuid()).default([]),
  items: z.array(DeliveryUpsertItemSchema).default([]),
  baseVersion: z.number().int().nonnegative().optional(),
  ...GroupOperationFields,
});
export type DeliveryUpsert = z.infer<typeof DeliveryUpsertSchema>;

export const DeliveryListResponseSchema = z.object({
  items: z.array(DeliverySchema),
  total: z.number(),
});

export const ConflictResponseSchema = z.object({
  error: z.literal('conflict'),
  serverVersion: z.number(),
  server: DeliverySchema,
});

/**
 * Подсказка для чипа «Получатель» карточки приёмки: подрядчик из справочника
 * «Контрагенты», которого называют стороны привязанных документов (по ИНН).
 * Только подсказка — подставляет и сохраняет человек.
 * GET /api/v1/deliveries/:id/recipient-suggestion.
 */
export const RecipientSuggestionSchema = z.object({
  customerCounterpartyId: z.string().uuid(),
  name: z.string(),
  inn: z.string(),
  from: z.enum(['buyer', 'consignee']),
  sourceDocumentId: z.string().uuid(),
});
export type RecipientSuggestion = z.infer<typeof RecipientSuggestionSchema>;

export const RecipientSuggestionResponseSchema = z.object({
  suggestion: RecipientSuggestionSchema.nullable(),
});
export type RecipientSuggestionResponse = z.infer<typeof RecipientSuggestionResponseSchema>;
