import { z } from 'zod';

// Виды source_documents:
//  - 'upd'                — УПД (PDF/XML), pdf-parse → текстовый LLM.
//  - 'request'            — заявка/письмо.
//  - 'transport_waybill'  — печатная транспортная накладная (форма РФ 2116).
//  - 'os2_transfer'       — накладная на внутреннее перемещение ОС (форма ОС-2).
//
// Накладные обоих видов (ТН и ОС-2) распознаются единым vision-LLM пайплайном
// (см. waybill-batch.parser.ts): пакет фото загружается одним POST,
// LLM классифицирует каждый файл и возвращает массив документов разных форм.
// Один пакет может породить N source_documents (см. source_bundles).
export const SourceKindSchema = z.enum([
  'upd',
  'request',
  'transport_waybill',
  'os2_transfer',
]);
export const SourceOriginSchema = z.enum(['edo_diadoc', 'manual_xml', 'manual_pdf', 'mail']);
export const SourceStatusSchema = z.enum([
  'parsed',
  'parse_failed',
  'archived',
  'queued',
  'processing',
  'needs_resolution',
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/**
 * Отображаемый статус документа = реальный статус из БД ИЛИ «draft»,
 * если документ распарсен, но в нём не заполнены ключевые поля для
 * привязки к приёмке/отгрузке. Это derived-статус в UI, в БД его нет.
 *
 * Условия «Черновика» (когда status='parsed'):
 *  - не указан получатель (Подрядчик ИЛИ МОЛ), ИЛИ
 *  - не указан Объект, ИЛИ
 *  - не указана Дата поставки.
 *
 * Когда пользователь дозаполнит и сохранит — derived-статус
 * автоматически переключится на «parsed» (= «Обработано»).
 */
export type DocumentDisplayStatus = SourceStatus | 'draft';

export function getDocumentDisplayStatus(sd: {
  status: SourceStatus;
  direction?: SourceDirection;
  contractorId?: string | null;
  // recipientId — внешний контрагент-получатель, нужен для outbound. На
  // inbound поле обычно null и не учитывается (там роль «получателя»
  // играет наш contractorId).
  recipientId?: string | null;
  recipientMolId?: string | null;
  expectedDate?: string | null;
  siteId?: string | null;
}): DocumentDisplayStatus {
  if (sd.status !== 'parsed') return sd.status;
  // Признак «получатель указан» зависит от направления документа:
  //   outbound: внешний контрагент (recipientId) ИЛИ наш МОЛ-получатель;
  //   inbound:  наш подрядчик-приёмник (contractorId) ИЛИ наш МОЛ.
  // Без direction (старые callsite'ы) — поведение как было: contractorId|MOL.
  const hasRecipient =
    sd.direction === 'outbound'
      ? !!(sd.recipientId || sd.recipientMolId)
      : !!(sd.contractorId || sd.recipientMolId);
  const hasExpectedDate = !!sd.expectedDate;
  const hasSite = !!sd.siteId;
  if (!hasRecipient || !hasExpectedDate || !hasSite) return 'draft';
  return 'parsed';
}

/** Русский лейбл и цвет antd-тега для каждого отображаемого статуса. */
export function getDocumentDisplayStatusLabel(s: DocumentDisplayStatus): {
  label: string;
  color: string;
} {
  switch (s) {
    case 'draft':
      return { label: 'Черновик', color: 'gold' };
    case 'parsed':
      return { label: 'обработано', color: 'green' };
    case 'queued':
      return { label: 'в очереди', color: 'default' };
    case 'processing':
      return { label: 'распознаётся', color: 'blue' };
    case 'needs_resolution':
      return { label: 'требует решения', color: 'orange' };
    case 'parse_failed':
      return { label: 'ошибка', color: 'red' };
    case 'archived':
      return { label: 'архив', color: 'default' };
  }
}

// Машинно-читаемый код ошибки/состояния, по которому UI решает, какой
// диалог показывать (skip/replace при дубле, alert при mismatch и т.д.).
export const SourceParseErrorCodeSchema = z.enum([
  'duplicate_upd',
  'validation_mismatch',
  'pdf_no_text',
  'parse_failed',
  'internal_error',
  // Шапка УПД распознана, но позиции/итого не извлечены — типично для
  // excel-парсера до Шага 2b. Документ записан со status='needs_resolution',
  // пользователь добавит позиции через UI.
  'partial_parse',
  // ТН-pipeline (legacy): ни один файл из пакета не классифицирован как печатная ТН.
  'no_transport_waybill_found',
  // Waybill-batch pipeline: в пакете не найдено ни одного распознаваемого
  // документа (ни ТН-2116, ни ОС-2). Только рукописное / паспорта качества / прочее.
  'no_waybill_found',
]);
export type SourceParseErrorCode = z.infer<typeof SourceParseErrorCodeSchema>;
export const SourceDirectionSchema = z.enum(['inbound', 'outbound']);
export type SourceDirection = z.infer<typeof SourceDirectionSchema>;

export const VolumeConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type VolumeConfidence = z.infer<typeof VolumeConfidenceSchema>;

export const SourceItemSchema = z.object({
  id: z.string().uuid(),
  materialId: z.string().uuid().nullable(),
  nameRaw: z.string(),
  qty: z.string(),
  unit: z.string(),
  price: z.string().nullable(),
  sum: z.string().nullable(),
  vatRate: z.string().nullable(),
  vatSum: z.string().nullable(),
  expectedDate: z.string().nullable(),
  lineNo: z.number(),
  volumeM3: z.string().nullable(),
  massKg: z.string().nullable(),
  volumeConfidence: VolumeConfidenceSchema.nullable(),
  groupName: z.string().nullable(),
  // Инвентарный номер ОС из строки накладной ОС-2 (например «119866»).
  // Заполняется только для документов kind='os2_transfer'; у ТН и УПД — null.
  // На фронте видимость столбца «Инв.№» в карточке отгрузки/приёмки
  // переключается по kind документа-источника.
  inventoryNumber: z.string().nullable(),
});
export type SourceItem = z.infer<typeof SourceItemSchema>;

export const SourceAttachmentSchema = z.object({
  id: z.string().uuid(),
  s3Key: z.string(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  role: z.enum(['original', 'extracted_text']),
});
export type SourceAttachment = z.infer<typeof SourceAttachmentSchema>;

// ──────────── Авто-сверка арифметики (см. apps/api/src/domain/edo/upd-validation.ts) ───────

export const UpdCheckNameSchema = z.enum([
  'sum_total',
  'vat_total',
  'items_count',
  'row_qty_price',
  'row_vat_rate',
]);
export type UpdCheckName = z.infer<typeof UpdCheckNameSchema>;

export const UpdCheckScopeSchema = z.union([
  z.literal('document'),
  z.object({ row: z.number().int().positive() }),
]);
export type UpdCheckScope = z.infer<typeof UpdCheckScopeSchema>;

export const UpdCheckSchema = z.object({
  name: UpdCheckNameSchema,
  scope: UpdCheckScopeSchema,
  expected: z.number().nullable(),
  actual: z.number().nullable(),
  diff: z.number().nullable(),
  tolerance: z.number(),
  ok: z.boolean(),
  skipReason: z.enum(['no_expected', 'no_actual']).optional(),
});
export type UpdCheck = z.infer<typeof UpdCheckSchema>;

export const UpdValidationSchema = z.object({
  hasMismatch: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(UpdCheckSchema),
});
export type UpdValidation = z.infer<typeof UpdValidationSchema>;

export const SourceDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: SourceKindSchema,
  direction: SourceDirectionSchema,
  status: SourceStatusSchema,
  supplierId: z.string().uuid().nullable(),
  recipientId: z.string().uuid().nullable(),
  contractorId: z.string().uuid().nullable(),
  recipientMolId: z.string().uuid().nullable(),
  siteId: z.string().uuid().nullable(),
  supplierName: z.string().nullable().optional(),
  contractorName: z.string().nullable().optional(),
  // recipientName актуально для outbound, когда поле «Получатель» —
  // внешний контрагент, выбранный из справочника. Для inbound поле
  // обычно null. Используется фронтом для отображения выбранного
  // контрагента в CustomerCounterpartySelect.
  recipientName: z.string().nullable().optional(),
  recipientMolName: z.string().nullable().optional(),
  siteName: z.string().nullable().optional(),
  // Пользователь, загрузивший УПД через /upload-upd или /upload-upd-pdf.
  // Для EDO/mail-полученных — NULL (нет конкретного юзера). Мобильный
  // клиент использует createdByUserPhone для кнопки звонка из шапки
  // списка материалов на 1 Этапе приёмки; при отсутствии кнопка не
  // рисуется.
  createdByUserId: z.string().uuid().nullable().optional(),
  createdByUserEmail: z.string().nullable().optional(),
  createdByUserPhone: z.string().nullable().optional(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  totalSum: z.string().nullable(),
  vatSum: z.string().nullable(),
  expectedDate: z.string().nullable(),
  origin: SourceOriginSchema,
  llmProviderId: z.string().uuid().nullable(),
  llmConfidence: z.string().nullable(),
  parsedAt: z.string(),
  queuedAt: z.string().nullable(),
  processedAt: z.string().nullable(),
  parseErrorCode: SourceParseErrorCodeSchema.nullable(),
  parseErrorDetails: z.record(z.unknown()).nullable(),
  originalFilename: z.string().nullable(),
  contentHash: z.string().nullable(),
  jobAttempts: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  validation: UpdValidationSchema.nullable(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const SourceDocumentDetailSchema = SourceDocumentSchema.extend({
  items: z.array(SourceItemSchema),
  attachments: z.array(SourceAttachmentSchema),
});
export type SourceDocumentDetail = z.infer<typeof SourceDocumentDetailSchema>;

export const SourceDocumentListResponseSchema = z.object({
  items: z.array(SourceDocumentSchema),
  total: z.number(),
});

export const ManualUpdUploadRequestSchema = z.object({
  xml: z.string().min(1).max(10_000_000),
  direction: SourceDirectionSchema,
  contractorId: z.string().uuid(),
  siteId: z.string().uuid(),
  // Опциональная дата фактической поставки товара. Сохраняется в
  // source_documents.expected_date — поле уже существует в схеме
  // (используется для заявок-request). Формат: YYYY-MM-DD.
  expectedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  // Если указан — подтверждение «Заменить» существующий УПД с этим id.
  // Сервер удалит старый и создаст новый.
  replaceExistingId: z.string().uuid().optional(),
});
export type ManualUpdUploadRequest = z.infer<typeof ManualUpdUploadRequestSchema>;

export const ManualUpdUploadResponseSchema = z.object({
  id: z.string().uuid(),
  itemsCount: z.number(),
});

// ──────────── Конфликт дубликата УПД (общий для PDF и XML) ────────────
// Возвращается с кодом 409, когда при загрузке найден УПД с тем же
// supplier_id + doc_number + doc_date. Клиент показывает диалог
// «Заменить / Пропустить» и при «Заменить» повторяет запрос с
// replaceExistingId = existing.id.

export const UpdDuplicateExistingSchema = z.object({
  id: z.string().uuid(),
  docNumber: z.string().nullable(),
  docDate: z.string().nullable(),
  supplierId: z.string().uuid().nullable(),
  totalSum: z.string().nullable(),
  createdAt: z.string(),
});
export type UpdDuplicateExisting = z.infer<typeof UpdDuplicateExistingSchema>;

export const UpdDuplicateConflictSchema = z.object({
  error: z.literal('duplicate_upd'),
  existing: UpdDuplicateExistingSchema,
});
export type UpdDuplicateConflict = z.infer<typeof UpdDuplicateConflictSchema>;

export const SourceDocumentDirectionUpdateSchema = z.object({
  direction: SourceDirectionSchema,
});
export type SourceDocumentDirectionUpdate = z.infer<typeof SourceDocumentDirectionUpdateSchema>;

// ──────────── PDF УПД (двухшаговый flow: parse → confirm) ────────────

export const UpdPdfPartySchema = z.object({
  inn: z.string().nullable().optional(),
  kpp: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

// Позиция УПД, возвращённая LLM.
//
// vatRate/vatSum — налоговая ставка (%) и сумма НДС по строке. Извлекаются
// промптом v5+: они нужны веб-портал для колонки «Сумма НДС» в таблице
// материалов приёмки. До v5 эти поля игнорировались (см. комментарий
// миграции 0019); старые позиции в БД остаются с NULL.
//
// z.preprocess мэппит snake_case → camelCase: если LLM (несмотря на
// промпт v5 и JSON Schema в camelCase) вернёт volume_m3/mass_kg/
// volume_confidence/group_name/name_raw/vat_rate/vat_sum — значения
// подхватятся в соответствующие camelCase-поля. Иначе Zod с .optional()
// молча отбрасывал бы snake_case ключи, и в БД попадал NULL.
const SNAKE_TO_CAMEL_ITEM: Record<string, string> = {
  volume_m3: 'volumeM3',
  mass_kg: 'massKg',
  volume_confidence: 'volumeConfidence',
  group_name: 'groupName',
  name_raw: 'nameRaw',
  vat_rate: 'vatRate',
  vat_sum: 'vatSum',
};
export const UpdPdfItemSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    for (const [snake, camel] of Object.entries(SNAKE_TO_CAMEL_ITEM)) {
      if (out[camel] == null && out[snake] != null) out[camel] = out[snake];
    }
    return out;
  },
  z.object({
    nameRaw: z.string().min(1),
    qty: z.number(),
    unit: z.string().default('шт'),
    // price — цена за единицу БЕЗ НДС (графа 4 формы УПД «Цена/тариф
    // за единицу»). Берётся как есть, не как sum/qty. См. промпт v7
    // (миграция 0061).
    price: z.number().nullable().optional(),
    // sum — стоимость С НАЛОГОМ — всего по строке (графа 9 формы УПД).
    // НЕ «Стоимость без налога» (графа 5). Веб-портал отображает это
    // значение в колонке «Сумма» позиций УПД. Внимание: price (без НДС)
    // и sum (с НДС) на разных налоговых базах — построчная проверка
    // qty × price ≈ sum / (1 + vatRate/100), см. upd-validation.ts.
    sum: z.number().nullable().optional(),
    // Налоговая ставка в процентах (например, 20, 10, 0). null допустим,
    // если строка «Без НДС» — тогда vatSum обычно тоже null/0.
    vatRate: z.number().nullable().optional(),
    // Сумма налога по строке в рублях (отдельная колонка «Сумма налога»
    // формы УПД, не путать с `sum`).
    vatSum: z.number().nullable().optional(),
    volumeM3: z.number().nullable().optional(),
    massKg: z.number().nullable().optional(),
    volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
    groupName: z.string().nullable().optional(),
  }),
);
export type UpdPdfItem = z.infer<typeof UpdPdfItemSchema>;

export const UpdPdfParsedSchema = z.object({
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(),
  totalSum: z.number().nullable().optional(),
  vatSum: z.number().nullable().optional(),
  // Значение из строки УПД «Всего наименований N»; null/undefined, если парсер
  // не смог его извлечь — тогда сверка по кол-ву позиций пропускается.
  itemsCount: z.number().int().nonnegative().nullable().optional(),
  supplier: UpdPdfPartySchema.nullable().optional(),
  recipient: UpdPdfPartySchema.nullable().optional(),
  items: z.array(UpdPdfItemSchema),
  // confidence — обязательное. Без default: если LLM не вернёт поле,
  // Zod бросит ошибку парсинга, воркер пометит документ parse_failed.
  // Раньше default(0.5) тихо подменял отсутствующее значение, и в UI у
  // всех документов была уверенность 50% (см. лог УПД 201/21125720).
  confidence: z.number().min(0).max(1),
});
export type UpdPdfParsed = z.infer<typeof UpdPdfParsedSchema>;

// ──────────── Накладные (ТН-2116 и ОС-2) — мульти-документный batch ────────
// Vision-LLM получает пакет изображений одним вызовом и возвращает массив
// найденных документов. Каждый документ классифицирован по форме
// (`tn_2116` или `os2`) и несёт свой набор полей. Один пакет → N
// source_documents в БД. Если массив пустой — worker помечает bundle как
// parse_failed с кодом 'no_waybill_found'.
//
// Партии файлов (например лицевая + оборотная одной ТН) LLM склеивает по
// совпадению docNumber и возвращает одним элементом массива.

export const WaybillPartySchema = z.object({
  inn: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
export type WaybillParty = z.infer<typeof WaybillPartySchema>;

// «Сдатчик»/«Получатель» в ОС-2 — внутренние подразделения, не контрагенты.
// `name` — ФИО МОЛ + текст (например «Медников Р.С. Основной склад IT»).
// `department` — отдельный текст подразделения, если LLM смогла выделить.
export const WaybillInternalPartySchema = z.object({
  name: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
});
export type WaybillInternalParty = z.infer<typeof WaybillInternalPartySchema>;

export const WaybillItemSchema = z.object({
  nameRaw: z.string().min(1),
  qty: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  // Инвентарный номер — заполняется только в ОС-2.
  invNumber: z.string().nullable().optional(),
  // Цены — заполняются только в ОС-2.
  price: z.number().nullable().optional(),
  sum: z.number().nullable().optional(),
});
export type WaybillItem = z.infer<typeof WaybillItemSchema>;

export const WaybillFormSchema = z.enum(['tn_2116', 'os2']);
export type WaybillForm = z.infer<typeof WaybillFormSchema>;

export const WaybillDocumentSchema = z.object({
  form: WaybillFormSchema,
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(), // YYYY-MM-DD
  // Только для tn_2116: грузоотправитель (поставщик).
  shipper: WaybillPartySchema.nullable().optional(),
  // Только для tn_2116: грузополучатель (подрядчик).
  consignee: WaybillPartySchema.nullable().optional(),
  // Только для os2: внутренний отправитель.
  sender: WaybillInternalPartySchema.nullable().optional(),
  // Только для os2: внутренний получатель.
  recipient: WaybillInternalPartySchema.nullable().optional(),
  // Только для os2: «Итого по документу» из шапки таблицы.
  totalSum: z.number().nullable().optional(),
  items: z.array(WaybillItemSchema),
  confidence: z.number().min(0).max(1),
});
export type WaybillDocument = z.infer<typeof WaybillDocumentSchema>;

export const WaybillBatchParsedSchema = z.object({
  // Пустой массив = LLM не нашла ни одного распознаваемого документа в пакете.
  // Worker пометит bundle как parse_failed с кодом 'no_waybill_found' и ни
  // одного source_document не создаёт.
  documents: z.array(WaybillDocumentSchema),
});
export type WaybillBatchParsed = z.infer<typeof WaybillBatchParsedSchema>;

export const SourceDocumentFileResponseSchema = z.object({
  url: z.string().url(),
  filename: z.string(),
  mimeType: z.string().nullable(),
});
export type SourceDocumentFileResponse = z.infer<typeof SourceDocumentFileResponseSchema>;

// ──────────── Асинхронная загрузка PDF УПД в очередь ────────────
// Запрос — multipart/form-data, поэтому Zod-схема описывает только
// нефайловые поля. Ответ — созданный документ в статусе 'queued'.

export const UpdPdfQueueRequestSchema = z.object({
  direction: SourceDirectionSchema,
  // Получатель — либо контрагент-подрядчик, либо МОЛ, либо ничего.
  // Multipart всегда приходит строкой, поэтому пустую строку приводим к null.
  contractorId: z
    .union([z.literal(''), z.string().uuid()])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  recipientMolId: z
    .union([z.literal(''), z.string().uuid()])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  siteId: z.string().uuid(),
  // Опциональная дата фактической поставки. Multipart всегда приходит
  // строкой, поэтому пустую строку приводим к null.
  expectedDate: z
    .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
});
export type UpdPdfQueueRequest = z.infer<typeof UpdPdfQueueRequestSchema>;

export const UpdPdfQueueResponseSchema = z.object({
  created: SourceDocumentSchema,
  // true, если файл с таким contentHash уже был загружен у этого подрядчика
  // — возвращён существующий документ, новый джоб не поставлен.
  alreadyExists: z.boolean(),
});
export type UpdPdfQueueResponse = z.infer<typeof UpdPdfQueueResponseSchema>;

// ──────────── Bulk-удаление source_documents ────────────
// Тело — массив id. Ответ — те, кого удалили, и те, кого пропустили
// (с указанием причины). Best-effort: каждая запись — независимая
// транзакция. Записи с привязками к приёмке/отгрузке не удаляются,
// а попадают в skipped с reason='has_references'. Идиоматично для
// bulk-операций: фронт показывает пользователю «удалено X, пропущено Y».

export const SourceDocumentBulkDeleteRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
export type SourceDocumentBulkDeleteRequest = z.infer<
  typeof SourceDocumentBulkDeleteRequestSchema
>;

export const SourceDocumentBulkDeleteSkipReasonSchema = z.enum([
  'has_references',
  'not_found',
  'internal_error',
]);
export type SourceDocumentBulkDeleteSkipReason = z.infer<
  typeof SourceDocumentBulkDeleteSkipReasonSchema
>;

export const SourceDocumentBulkDeleteResponseSchema = z.object({
  deleted: z.array(z.string().uuid()),
  skipped: z.array(
    z.object({
      id: z.string().uuid(),
      reason: SourceDocumentBulkDeleteSkipReasonSchema,
    }),
  ),
});
export type SourceDocumentBulkDeleteResponse = z.infer<
  typeof SourceDocumentBulkDeleteResponseSchema
>;

// ──────────── Разрешение статуса needs_resolution ────────────

export const UpdResolveDuplicateRequestSchema = z.object({
  action: z.enum(['skip', 'replace']),
});
export type UpdResolveDuplicateRequest = z.infer<typeof UpdResolveDuplicateRequestSchema>;

export const UpdAcknowledgeMismatchRequestSchema = z.object({
  reason: z.string().max(1000).optional(),
});
export type UpdAcknowledgeMismatchRequest = z.infer<typeof UpdAcknowledgeMismatchRequestSchema>;

// ──────────── Журнал LLM-вызовов (для админского drawer) ────────────

export const LlmCallSchema = z.object({
  id: z.string().uuid(),
  sourceDocumentId: z.string().uuid().nullable(),
  providerId: z.string().uuid().nullable(),
  promptId: z.string().uuid().nullable(),
  docKind: z.string(),
  model: z.string().nullable(),
  requestMessages: z.unknown(),
  requestSchema: z.unknown().nullable(),
  responseRaw: z.string().nullable(),
  responseParsed: z.unknown().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  latencyMs: z.number(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type LlmCall = z.infer<typeof LlmCallSchema>;

export const LlmCallListResponseSchema = z.object({
  items: z.array(LlmCallSchema),
});
