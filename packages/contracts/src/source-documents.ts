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
export const SourceKindSchema = z.enum(['upd', 'request', 'transport_waybill', 'os2_transfer']);
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
  // Получатель обязателен только у ОТГРУЗКИ: там мы отдаём материалы наружу, и
  // без внешнего контрагента либо нашего МОЛ непонятно кому.
  //
  // У приёмки подрядчик перестал быть обязательным. Инспектору он не нужен:
  // на площадке важно, ОТ КОГО груз и КОМУ он адресован, а это поставщик и
  // грузополучатель — оба распознаются из самого документа. Подрядчик — это
  // внутренняя привязка затрат, её проставляет менеджер, и ждать её значило бы
  // держать поставку на портале, пока машина стоит под разгрузкой.
  //
  // Приёмка без подрядчика допустима и в базе: CHECK deliveries_recipient_chk
  // запрещает только оба поля сразу, а «оба NULL» — обычная приёмка от
  // внешнего поставщика.
  const hasRecipient = sd.direction === 'outbound' ? !!(sd.recipientId || sd.recipientMolId) : true;
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
  // Файл из обязательной зоны формы, тип которого не подтвердили ни текстовый
  // классификатор, ни vision. Документ заведён пустым (status='needs_resolution')
  // ТОЛЬКО чтобы файл не исчез из виду: распознавать больше нечем, разбирает
  // человек и закрывает вопрос кнопкой «Разобрано вручную».
  'unrecognized_type',
  // Сопроводительный документ: сертификат, паспорт качества, декларация,
  // проформа — либо файл из зоны «Дополнительные документы». Реквизиты из него
  // не нужны, разбирать нечего, поэтому документ заводится сразу archived. Он
  // существует только затем, чтобы файл был виден и открывался.
  'supplementary',
  // Файл принят, но документа из него не вышло по технической причине: не
  // скачался из S3, упал разбор, не дошёл до классификации. Отдельный код, а не
  // internal_error: последний носят и обычные документы со сломавшимся
  // разбором, а их прятать из «Ожидаемых» и /sync нельзя.
  'not_processed',
  // Распознавание зависало и исчерпало отведённые поколения. Отдельный код, а
  // не not_processed: там разбор упал и сказал почему, здесь работа просто не
  // доехала — диагноз и для менеджера, и для метрик разный.
  'recovery_exhausted',
]);
export type SourceParseErrorCode = z.infer<typeof SourceParseErrorCodeSchema>;

/**
 * Документ-заглушка: запись, заведённая ради того, чтобы принятый файл был
 * виден и открывался, а не ради его содержимого. Реквизитов у неё нет.
 *
 * Отбор ВСЕГДА по паре (статус, код), а не по одному коду: `not_processed`
 * рядом с `parse_failed` — это обычный документ, у которого сорвался разбор, и
 * из выдач он исчезать не должен.
 */
export const STUB_ERROR_CODES = [
  'unrecognized_type',
  'no_waybill_found',
  'not_processed',
  'supplementary',
  // Документ, у которого распознавание так и не доехало. Реквизитов у него нет
  // по той же причине, что у not_processed. Без этой строки он не считался бы
  // заглушкой: портал опрашивал бы его как «ещё в работе» бесконечно, кнопки
  // «разобрано» у него не было бы, а /sync отдал бы его инспектору пустым.
  'recovery_exhausted',
] as const satisfies readonly SourceParseErrorCode[];

/**
 * Заглушки, которые ЖДУТ человека: он открывает файл, вводит реквизиты или
 * закрывает вопрос кнопкой «Разобрано вручную».
 *
 * `supplementary` сюда не входит: он заводится сразу archived, разбирать в нём
 * нечего.
 */
export const ACTIONABLE_STUB_CODES = [
  'unrecognized_type',
  'no_waybill_found',
  'not_processed',
  'recovery_exhausted',
] as const satisfies readonly SourceParseErrorCode[];

/** Заглушка ли это — см. STUB_ERROR_CODES про пару (статус, код). */
export function isStubDocument(row: {
  status: string | null;
  parseErrorCode: string | null;
}): boolean {
  if (row.status !== 'needs_resolution' && row.status !== 'archived') return false;
  return (STUB_ERROR_CODES as readonly string[]).includes(row.parseErrorCode ?? '');
}

/** Заглушка, ожидающая ручного разбора. Archived сюда не попадает по статусу. */
export function isActionableStub(row: {
  status: string | null;
  parseErrorCode: string | null;
}): boolean {
  if (row.status !== 'needs_resolution') return false;
  return (ACTIONABLE_STUB_CODES as readonly string[]).includes(row.parseErrorCode ?? '');
}
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
  // Непрерывность напечатанных номеров позиций (графа 1). Ловит то, чего не
  // видит арифметика: строку, потерянную при переносе многострочного
  // наименования, и позицию, задвоенную моделью.
  'items_sequence',
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

/**
 * Подозрения, которые арифметика доказать не может.
 *
 * Отдельно от `checks`, потому что это не проверка, а догадка по виду чисел:
 * она не входит в `hasMismatch`, не попадает в `failedChecks` и не запускает
 * второй проход — только подсвечивает строку оператору.
 */
export const UpdWarningNameSchema = z.enum(['qty_price_swap']);
export type UpdWarningName = z.infer<typeof UpdWarningNameSchema>;

export const UpdWarningSchema = z.object({
  name: UpdWarningNameSchema,
  scope: UpdCheckScopeSchema,
});
export type UpdWarning = z.infer<typeof UpdWarningSchema>;

export const UpdValidationSchema = z.object({
  hasMismatch: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(UpdCheckSchema),
  // Опционально: у записей, сделанных до появления поля, его просто нет.
  warnings: z.array(UpdWarningSchema).optional(),
});
export type UpdValidation = z.infer<typeof UpdValidationSchema>;

/**
 * Похоже ли, что количество и цена в строке поменялись местами.
 *
 * Зачем эвристика вообще. Перестановку нельзя поймать арифметикой: проверка
 * `qty × price ≈ sum` от перемены множителей не меняется, и строка проходит как
 * корректная. На бою так прошёл УПД № 848 — «66,294 м² × 8 114,75 ₽» приехало
 * как `qty 8114.75 / price 66.294`.
 *
 * Почему именно эти три условия. Цена хранится как numeric(18,4), и 65.4918 —
 * законное значение, поэтому сама по себе дробная цена поводом не считается.
 * Сигналом становится только совпадение всего сразу: у цены необычная для денег
 * точность, у количества — ровно денежная (два знака), и количество крупнее
 * цены. На корректных строках того же дня (200 × 451.68, 84 × 148.32,
 * 66.294 × 8114.75) не срабатывает.
 *
 * Правило про штучные единицы намеренно не добавлено: `unit` схлопывается в
 * «шт» когда единицу не распознали, и «шт + дробное qty» давало бы ложные
 * предупреждения на ровном месте.
 */
export function suspectQtyPriceSwap(item: {
  qty?: number | null;
  price?: number | null;
}): boolean {
  const { qty, price } = item;
  if (qty == null || price == null) return false;
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return false;
  if (qty <= price) return false;
  return decimalsOf(price) >= 3 && decimalsOf(qty) === 2;
}

/** Сколько знаков после запятой у числа (без хвостовых нулей). */
function decimalsOf(n: number): number {
  // toFixed(6) вместо String(n): у 0.1 + 0.2 строковое представление даёт 17
  // знаков, и любое число после арифметики выглядело бы «необычно точным».
  const fixed = n.toFixed(6).replace(/0+$/, '');
  const dot = fixed.indexOf('.');
  if (dot < 0) return 0;
  return fixed.length - dot - 1;
}

/**
 * Происхождение получателя inbound-документа (contractor_id либо МОЛ).
 *
 *  null        — получателя не задавали ни человек, ни автоматика;
 *  'manual'    — задал человек: подрядчик, МОЛ или явная очистка поля;
 *  'auto_buyer'— подставлен резолвером из покупателя (графа 6) распознанного УПД.
 *
 * Только для direction='inbound': у outbound получатель — recipient_id, а
 * contractor_id там наш отправитель и «Черновиком» документ из-за него не станет.
 *
 * Значение 'auto_buyer' НЕ даёт прав роли contractor: содержимое файла с
 * публичной страницы недоверенное, см. lib/contractor-scope.ts.
 */
export const RecipientSourceSchema = z.enum(['manual', 'auto_buyer']);
export type RecipientSource = z.infer<typeof RecipientSourceSchema>;

export const SourceWorkHealthSchema = z.enum([
  'alive',
  'missing',
  'terminal',
  'overdue',
  'unknown',
]);
export type SourceWorkHealth = z.infer<typeof SourceWorkHealthSchema>;

export const SourceDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: SourceKindSchema,
  direction: SourceDirectionSchema,
  status: SourceStatusSchema,
  supplierId: z.string().uuid().nullable(),
  recipientId: z.string().uuid().nullable(),
  contractorId: z.string().uuid().nullable(),
  recipientMolId: z.string().uuid().nullable(),
  // Optional по той же причине, что fromSupplierPortal ниже: схема общая с
  // /sync и PATCH-ответами.
  recipientSource: RecipientSourceSchema.nullable().optional(),
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
  // Стороны САМОГО документа: покупатель (графа 6) и грузополучатель (графа 4).
  // Не путать с contractorId/recipientId — те выбирает человек, эти извлекает
  // распознавание. Имена приходят из *_name_raw, поэтому buyerName может быть
  // заполнен при пустом buyerId: графу 4 часто печатают без ИНН, а связать
  // сторону с контрагентом без ИНН нельзя.
  //
  // Все четыре optional: схема общая с /sync и PATCH-ответами, и producers,
  // которые эти поля не собирают, не должны падать на валидации.
  buyerId: z.string().uuid().nullable().optional(),
  buyerName: z.string().nullable().optional(),
  consigneeId: z.string().uuid().nullable().optional(),
  consigneeName: z.string().nullable().optional(),
  // ИНН сторон для второй строки ячейки в списке. Сервер собирает их как
  // COALESCE(*_inn_raw, ИНН справочной записи по FK): распознанный ИНН
  // приоритетнее, справочник закрывает документы до миграции 0095.
  //
  // Optional по той же причине, что и имена: схема общая с /sync и
  // PATCH-ответами, а /sync ИНН не собирает — мобильному клиенту он не нужен.
  supplierInn: z.string().nullable().optional(),
  buyerInn: z.string().nullable().optional(),
  consigneeInn: z.string().nullable().optional(),
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
  workHealth: SourceWorkHealthSchema.optional(),
  originalFilename: z.string().nullable(),
  contentHash: z.string().nullable(),
  jobAttempts: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  validation: UpdValidationSchema.nullable(),
  // Документ пришёл с публичной страницы /uploads (от поставщика).
  // Признак — наличие ingest_event с channel='public' у КОРНЕВОГО пакета:
  // накладные router разворачивает в дочерний пакет, и по прямому bundle_id
  // событие не найдётся. Поле optional: схема используется не только в
  // detail-роуте, но и в /sync и в PATCH-ответах, а producers, которые его не
  // считают, не должны падать на валидации ответа.
  fromSupplierPortal: z.boolean().optional(),
  // Идентификатор «машины» — КОРНЕВОЙ пакет загрузки, COALESCE(parent_bundle_id, id).
  // Одна карточка «Машина N» на /uploads = один POST = один корневой пакет, из
  // которого может выйти несколько документов (УПД + УПД + транспортная
  // накладная). Планшет склеивает их в одну карточку и одну приёмку, иначе
  // инспектор оформляет одну и ту же машину несколько раз.
  //
  // Корень, а не bundle_id документа: накладные и сборку УПД router
  // разворачивает в дочерний пакет — та же причина, что у fromSupplierPortal.
  //
  // Непустой ТОЛЬКО для assembly_version='logical_v1', где граница документа —
  // логическая УПД. Для legacy («файл = документ») и для документов без пакета
  // приходит null: там группа = сам документ, склеивать страницы одной УПД в
  // общий список позиций нельзя.
  groupId: z.string().uuid().nullable().optional(),
  // source_bundles.group_revision корневого пакета: растёт и при изменении
  // состава группы, и при изменении реквизитов/позиций любого её документа.
  // Планшет запоминает значение на момент загрузки формы и сверяет перед
  // финализацией — «состав тот же, но суммы другие» сравнением множества id
  // не ловится. Непустой при тех же условиях, что groupId.
  groupRevision: z.number().int().nullable().optional(),
  // «Машина» глазами МЕНЕДЖЕРА: тот же корневой пакет, но без ожидания сборки
  // и публикации. Нужен там, где groupId ещё (или уже) пуст: пока пачка
  // разбирается и после отката сборки на «файл = документ». Менеджер обязан
  // видеть, что строки приехали одним рейсом, раньше инспектора.
  //
  // Непустой только для загрузок с публичного портала: у почты и внутренних
  // загрузок пачка файлов не означает один рейс. Планшет это поле не
  // использует — на нём машина по-прежнему определяется groupId.
  portalGroupId: z.string().uuid().nullable().optional(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/** Публичная отправка: комментарий поставщика и время. Недоверенный текст. */
export const SourceSubmissionSchema = z.object({
  comment: z.string().nullable(),
  submittedAt: z.string(),
});
export type SourceSubmission = z.infer<typeof SourceSubmissionSchema>;

// Файл поставки, сохранённый БЕЗ распознавания: либо человек положил его в
// зону «Дополнительные документы», либо тип определить не удалось. s3Key
// намеренно не отдаём — ссылка выдаётся отдельным маршрутом с проверкой прав.
export const ExtraFileSchema = z.object({
  id: z.string().uuid(),
  /** Пакет, которому принадлежит файл: корневой пакет поставки. */
  bundleId: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  /** null — файл из второй зоны формы, классификация не запускалась. */
  detectedKind: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ExtraFile = z.infer<typeof ExtraFileSchema>;

/**
 * Состояние ручного повторного распознавания (кнопка «Распознать повторно»).
 *
 * Отдаётся только в карточке документа: списку хватает статуса строки — повтор
 * возвращает документ в `queued`, и таблица сама показывает «в очереди».
 * А вот ОТКАЗ повтора статусом не виден вовсе: неудачная попытка восстанавливает
 * прежнее состояние документа целиком, и без этого поля кнопка выглядела бы как
 * «нажал — ничего не произошло».
 */
export const SourceReparseStateSchema = z.object({
  state: z.enum(['queued', 'processing', 'succeeded', 'failed']),
  /** Поколение диспетчеризации, к которому относится попытка. */
  generation: z.number(),
  at: z.string(),
  /** Почему повтор не удался. Заполняется только у state='failed'. */
  reason: z.string().nullable().optional(),
});
export type SourceReparseState = z.infer<typeof SourceReparseStateSchema>;

export const SourceDocumentDetailSchema = SourceDocumentSchema.extend({
  items: z.array(SourceItemSchema),
  attachments: z.array(SourceAttachmentSchema),
  // null — повтор ни разу не запускался. Optional по той же причине, что и
  // submission: схема переиспользуется ответами PATCH/POST и /sync.
  reparse: SourceReparseStateSchema.nullable().optional(),
  // Файлы поставки, которые не распознавались. Показываются у любого документа
  // комплекта: карточка одна на все типы, а сертификат относится к поставке
  // целиком. `.default([])` без внешнего `.optional()` — входное поле остаётся
  // необязательным (схема переиспользуется ответами PATCH/POST, где его нет), а
  // на выходе массив обязателен и фронту не нужен `?? []`.
  extraFiles: z.array(ExtraFileSchema).default([]),
  // Последняя публичная отправка этого комплекта: комментарий поставщика и
  // время. Персональных данных здесь нет, поэтому доступно всем, кто видит
  // документ. Optional по той же причине, что и fromSupplierPortal: схема
  // используется ещё и в /sync, и в PATCH-ответах, где поле не считается.
  submission: SourceSubmissionSchema.nullable().optional(),
});
export type SourceDocumentDetail = z.infer<typeof SourceDocumentDetailSchema>;

/**
 * Принятый файл, по которому документа ещё нет.
 *
 * Раньше такой файл не был виден в «Документах» вообще: он появлялся там
 * только по итогам разбора — настоящим документом или заглушкой. Между приёмом
 * и разбором (а при зависшей очереди это часы) менеджер видел пустоту и не мог
 * отличить «поставщик ничего не присылал» от «прислал, но мы ещё не разобрали».
 *
 * Это НЕ документ: у него нет ни реквизитов, ни статуса разбора, и принять его
 * нельзя. Поэтому отдельный тип и отдельное поле ответа, а не элемент items.
 */
export const PendingFileSchema = z.object({
  /**
   * Стабильный ключ строки для UI — `registry:<itemId>`.
   *
   * С префиксом намеренно: список рисует ожидающие файлы вместе с документами,
   * и без него React мог бы переиспользовать DOM-строку файла для появившегося
   * по нему документа — с чужим состоянием раскрытия и выделения.
   */
  key: z.string(),
  itemId: z.string().uuid(),
  bundleId: z.string().uuid(),
  /** Машина, в которую входит файл (для той же цветовой метки, что у документов). */
  portalGroupId: z.string().uuid().nullable(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  siteName: z.string().nullable(),
  expectedDate: z.string().nullable(),
  /** Когда файл приняли. */
  createdAt: z.string(),
  /**
   * `awaiting_processing` — файл в хранилище, ждёт разбора.
   * `not_stored` — форма приняла, хранилище не взяло: нужна повторная отправка.
   *   Ссылки на такой файл нет и быть не может — объекта не существует.
   */
  state: z.enum(['awaiting_processing', 'not_stored']),
});
export type PendingFile = z.infer<typeof PendingFileSchema>;

export const SourceDocumentListResponseSchema = z.object({
  items: z.array(SourceDocumentSchema),
  total: z.number(),
  /**
   * Принятые файлы без документа. Отдаются только на ПЕРВОЙ странице (offset=0)
   * со своим счётчиком: items листаются и сортируются по реквизитам документа,
   * которых у файла нет, и подмешивание сломало бы и пагинацию, и total.
   */
  pendingFiles: z.array(PendingFileSchema).optional(),
  pendingTotal: z.number().optional(),
});

// Компактный снимок «основного» документа-источника операции — первого
// элемента sourceDocumentIds (по возрастанию sourceDocumentId, тот же порядок,
// что и в массиве). Нужен спискам «Операции», чтобы показать номер/контрагента/
// поставщика/сумму привязанного документа БЕЗ отдельной выгрузки всего
// справочника документов (раньше фронт тянул source-documents?limit=1000).
// supplierName/contractorName сервер резолвит тем же COALESCE, что и в
// GET /source-documents: supplierName = COALESCE(suppliers.name,
// counterparties.name); contractorName = counterparties.name по contractor_id.
//
// buyerName/consigneeName — стороны из шапки УПД, теми же выражениями, что в
// основном DTO: COALESCE(*_name_raw, counterparties.name). Именно COALESCE, а не
// голый JOIN: графу 4 печатают без ИНН, связать такую сторону не с чем, и без
// *_name_raw грузополучатель исчезал бы ровно в историях операций.
export const PrimarySourceDocumentSchema = z.object({
  id: z.string().uuid(),
  kind: SourceKindSchema,
  docNumber: z.string().nullable(),
  totalSum: z.string().nullable(),
  contractorId: z.string().uuid().nullable(),
  supplierName: z.string().nullable(),
  contractorName: z.string().nullable(),
  buyerName: z.string().nullable(),
  consigneeName: z.string().nullable(),
  // ИНН тех же сторон — второй строкой в ячейке истории операций. Здесь без
  // optional: оба продюсера (deliveries.ts, shipments.ts) считают их одним
  // выражением с основным DTO, и пропуск поля был бы дефектом, а не вариантом.
  supplierInn: z.string().nullable(),
  buyerInn: z.string().nullable(),
  consigneeInn: z.string().nullable(),
});
export type PrimarySourceDocument = z.infer<typeof PrimarySourceDocumentSchema>;

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
/**
 * Числовое поле ответа модели, которое НЕ ИМЕЕТ ПРАВА уронить разбор.
 *
 * 19.08 промпт v13 попросил номер позиции, модель вернула `"rowNo": "1"`
 * строкой, и `z.number()` отверг ВЕСЬ ответ: корректно распознанная ТТН
 * (номер, дата, стороны, позиция с суммами) превратилась в «не распознано».
 * Отсюда правило: необязательное поле, добавленное ради диагностики, при любом
 * непонятном значении становится null, а документ живёт дальше.
 *
 * `positiveInt` — для номеров строк: дробное, ноль и отрицательное значат, что
 * прочитано не то, и тоже дают null.
 */
function lenientNumber(opts: { positiveInt?: boolean } = {}) {
  return z.preprocess((raw) => {
    let n: number | null = null;
    if (typeof raw === 'number') {
      n = Number.isFinite(raw) ? raw : null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim().replace(',', '.');
      if (trimmed === '') return null;
      // Только строка, которая ЦЕЛИКОМ число. «1а» — законный номер подпозиции
      // в бланке, но не число: parseFloat дал бы 1 и создал дубль с настоящей
      // первой строкой, то есть ложное расхождение на ровном месте.
      if (!/^-?\d+(\.\d*)?$/.test(trimmed)) return null;
      const parsed = Number.parseFloat(trimmed);
      n = Number.isFinite(parsed) ? parsed : null;
    } else {
      return null;
    }
    if (n == null) return null;
    if (!opts.positiveInt) return n;
    // «3.» и «3» — номер строки; «2.7» — прочитано не то поле.
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }, z.number().nullable().optional());
}

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
    // rowNo — порядковый номер позиции из графы 1 бланка, как он НАПЕЧАТАН.
    // Нужен не для отображения, а для проверки целостности списка: числа и
    // наименования съезжают на соседнюю строку, когда наименование занимает
    // две-три печатных строки, и суммы при этом иногда продолжают сходиться.
    // Последовательность 1..N без пропусков и дублей — единственный признак,
    // не зависящий от бланка и от того, напечатано ли «Всего наименований».
    // Опционально: старые версии промпта поле не возвращают, и проверка тогда
    // просто пропускается.
    rowNo: lenientNumber({ positiveInt: true }),
    // qty допускает null: строки-услуги УПД (доставка, погрузка) идут без
    // количества (в графе 3 формы прочерк «--»), и модель честно возвращает
    // null. ВАЖНО оставить именно null (не коерсить в 0): построчная сверка
    // qty × price в validateUpdTotals пропускает строку только при qty==null;
    // если подставить 0, а модель вернёт price — получаем ложный mismatch
    // «0 ≠ base». Дефолт для вставки в БД ('0') ставит воркер (как waybill-путь).
    qty: z.number().nullable().optional(),
    // unit нормализуем в 'шт': на суммы не влияет, а `.default('шт')` не ловил
    // null (только undefined) — отсюда часть исходного бага.
    unit: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v && v.trim() ? v : 'шт')),
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
    // Те же необязательные поля-довески: их формат тоже не должен решать
    // судьбу документа.
    volumeM3: lenientNumber(),
    massKg: lenientNumber(),
    volumeConfidence: VolumeConfidenceSchema.nullable().optional(),
    groupName: z.string().nullable().optional(),
  }),
);
export type UpdPdfItem = z.infer<typeof UpdPdfItemSchema>;

export const UpdPricingSchema = z.preprocess(
  (value) => {
    if (value == null) return value;
    return value === 'printed' || value === 'absent' || value === 'unclear' ? value : null;
  },
  z.enum(['printed', 'absent', 'unclear']).nullable().optional(),
);
export type UpdPricing = z.infer<typeof UpdPricingSchema>;

export const UpdPdfParsedSchema = z.object({
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(),
  totalSum: z.number().nullable().optional(),
  vatSum: z.number().nullable().optional(),
  // Явный ответ модели: стоимость напечатана, структурно отсутствует либо
  // качество изображения не позволяет решить. optional сохраняет ответы всех
  // старых промптов; мусор приводится к null и не влияет на готовность.
  pricing: UpdPricingSchema,
  // Значение из строки УПД «Всего наименований N»; null/undefined, если парсер
  // не смог его извлечь — тогда сверка по кол-ву позиций пропускается.
  itemsCount: z.number().int().nonnegative().nullable().optional(),
  supplier: UpdPdfPartySchema.nullable().optional(),
  recipient: UpdPdfPartySchema.nullable().optional(),
  // Грузополучатель (графа 4). Появился в промпте v9; на v8 и старше приходит
  // undefined, поэтому optional — иначе воркер помечал бы parse_failed всё,
  // что разобрано прежним промптом. ИНН в графе 4 печатают редко: сторона
  // сохраняется как текст (consignee_name_raw), а FK — только когда ИНН есть.
  consignee: UpdPdfPartySchema.nullable().optional(),
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

// tn_1t — товарно-транспортная накладная формы № 1-Т (Госкомстат №78, ОКУД
// 0345009). Отдельное значение, а не 'tn_2116': формы разные, и по ним
// по-разному читаются стороны — в 1-Т грузоотправитель и грузополучатель
// печатаются в шапке товарного раздела, а не в нумерованных разделах 2116.
// В kind документа обе дают 'transport_waybill', то есть тег «Накладная» на
// портале и планшете одинаков.
export const WaybillFormSchema = z.enum(['tn_2116', 'tn_1t', 'os2']);
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

// ──────────── Единый вход «Загрузить документы» (router) ────────────
// Экспериментальный общий вход: одна кнопка принимает любые поддерживаемые
// файлы (PDF/Excel/изображения), система сама классифицирует и роутит в
// существующие парсеры, записывая решение по каждому файлу (журнал
// bundle_import_items). Старые точечные эндпоинты остаются.

// Запрос — те же поля метаданных, что у УПД/накладных (multipart).
export const UploadDocumentsRequestSchema = UpdPdfQueueRequestSchema;
export type UploadDocumentsRequest = z.infer<typeof UploadDocumentsRequestSchema>;

export const UploadDocumentsResponseSchema = z.object({
  bundleId: z.string().uuid(),
  // queued | processing | parsed | parse_failed
  status: z.string(),
  // true — этот же набор файлов уже загружали (вернули существующий bundle).
  alreadyExists: z.boolean(),
  // Файлы, принятые формой, но не легшие в хранилище: остальные при этом
  // сохранены и разбираются. Пусто в подавляющем большинстве загрузок.
  // Необязательное — старые клиенты поля не ждут.
  notStored: z.array(z.string()).optional(),
});
export type UploadDocumentsResponse = z.infer<typeof UploadDocumentsResponseSchema>;

// Тип, который классификатор присвоил файлу.
export const DocClassSchema = z.enum([
  'upd',
  'transport_waybill',
  'os2_transfer',
  'm15',
  // Документ о качестве или соответствии: сертификат, паспорт качества,
  // декларация, протокол испытаний. Реквизиты из него не берут.
  'supplementary',
  'unknown',
]);
export type DocClass = z.infer<typeof DocClassSchema>;

// Одна строка журнала решений (bundle_import_items): что сделали с файлом.
export const ImportItemSchema = z.object({
  id: z.string().uuid(),
  sourceFilename: z.string(),
  // null у файлов из зоны «Дополнительные документы»: их не классифицируют.
  detectedKind: DocClassSchema.nullable(),
  confidence: z.number().nullable(),
  parserUsed: z.string().nullable(),
  // created | needs_review | skipped | failed
  status: z.string(),
  reason: z.string().nullable(),
  createdDocumentIds: z.array(z.string()),
});
export type ImportItem = z.infer<typeof ImportItemSchema>;

// Результат импорта пачки: сводка + список файлов с решениями.
export const ImportResultSchema = z.object({
  bundleId: z.string().uuid(),
  status: z.string(),
  summary: z.object({
    created: z.number(),
    needsReview: z.number(),
    failed: z.number(),
    // Сохранены без распознавания: вторая зона формы и файлы с неопознанным
    // типом. Без отдельного счётчика менеджер решил бы, что файл потерялся.
    skipped: z.number(),
  }),
  items: z.array(ImportItemSchema),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

// ──────────── Комплекты без распознанных документов ────────────
// Поставка, в которой ни одного документа не появилось: прислали только
// сертификаты, либо тип ни одного файла определить не удалось. Карточки
// документа у такой поставки нет, и это единственная точка входа к её файлам.

export const ExtraOnlyBundleSchema = z.object({
  bundleId: z.string().uuid(),
  siteName: z.string().nullable(),
  expectedDate: z.string().nullable(),
  createdAt: z.string(),
  /** Комментарий поставщика из публичной отправки; null — внутренняя загрузка. */
  comment: z.string().nullable(),
  files: z.array(ExtraFileSchema),
});
export type ExtraOnlyBundle = z.infer<typeof ExtraOnlyBundleSchema>;

export const ExtraOnlyBundleListResponseSchema = z.object({
  items: z.array(ExtraOnlyBundleSchema),
  total: z.number(),
});
export type ExtraOnlyBundleListResponse = z.infer<typeof ExtraOnlyBundleListResponseSchema>;

// ──────────── Bulk-удаление source_documents ────────────
// Тело — массив id. Ответ — те, кого удалили, и те, кого пропустили
// (с указанием причины). Best-effort: каждая запись — независимая
// транзакция. Записи с привязками к приёмке/отгрузке не удаляются,
// а попадают в skipped с reason='has_references'. Идиоматично для
// bulk-операций: фронт показывает пользователю «удалено X, пропущено Y».

export const SourceDocumentBulkDeleteRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
export type SourceDocumentBulkDeleteRequest = z.infer<typeof SourceDocumentBulkDeleteRequestSchema>;

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

/**
 * Ответ POST /source-documents/:id/reparse.
 *
 * `plan` — каким путём документ будет распознан заново: тем же, каким он
 * появился. Возвращается не ради UI (он ждёт смены статуса строки), а ради
 * диагностики: по логу видно, что накладная ушла m15-путём, а УПД из комплекта
 * фото — сегментным, а не «одним файлом целиком».
 */
export const SourceReparseResponseSchema = z.object({
  ok: z.literal(true),
  plan: z.enum(['single', 'm15', 'segment', 'waybill']),
});
export type SourceReparseResponse = z.infer<typeof SourceReparseResponseSchema>;
export const SourceRecoverResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(['recovered', 'terminalized']),
  generation: z.number().int().nonnegative(),
  jobId: z.string().nullable(),
  reason: z.string().optional(),
});
export type SourceRecoverResponse = z.infer<typeof SourceRecoverResponseSchema>;

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
