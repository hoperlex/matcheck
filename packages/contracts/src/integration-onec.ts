/**
 * Машинный канал выгрузки приёмок в 1С: /api/v1/integration/1c/*.
 *
 * Протокол обмена описан в docs/ONEC_API.md. Здесь только форма данных.
 * Деньги и количества — строками (numeric как есть, без float).
 * В мобильный OpenAPI-реестр эти схемы НЕ входят: это отдельный потребитель.
 */
import { z } from 'zod';

// ─────────────────────────── Выдача токена ───────────────────────────────

export const IntegrationTokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().min(1).max(64),
  client_secret: z.string().min(1).max(256),
});
export type IntegrationTokenRequest = z.infer<typeof IntegrationTokenRequestSchema>;

export const IntegrationTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  scope: z.string(),
});
export type IntegrationTokenResponse = z.infer<typeof IntegrationTokenResponseSchema>;

// ─────────────────────────── Данные приёмки ──────────────────────────────

const MoneyString = z.string();

export const OnecContractSchema = z.object({
  onecId: z.string(),
  counterpartyOnecId: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  name: z.string(),
});
export type OnecContract = z.infer<typeof OnecContractSchema>;

export const OnecRecipientSchema = z.object({
  kind: z.enum(['contractor', 'mol', 'none']),
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  name: z.string().nullable(),
  /** id МОЛ (responsible_persons) при kind = 'mol'. */
  molId: z.string().nullable(),
});
export type OnecRecipient = z.infer<typeof OnecRecipientSchema>;

export const OnecPartySchema = z.object({
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  name: z.string().nullable(),
});
export type OnecParty = z.infer<typeof OnecPartySchema>;

export const OnecEdoSchema = z.object({
  matchId: z.string(),
  /** Строка реестра ЭДО (Диадок/СБИС) — основной путь. */
  exportDocumentId: z.string().nullable(),
  /** Импортированная карточка Диадока — старый путь. */
  sourceDocumentId: z.string().nullable(),
  operator: z.string(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  correctionNumber: z.string().nullable(),
  supplierInn: z.string().nullable(),
  totalSum: MoneyString.nullable(),
  vatSum: MoneyString.nullable(),
  sha256: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  xmlAvailable: z.boolean(),
  /** Путь для GET с тем же Bearer-токеном; null — XML недоступен. */
  xmlPath: z.string().nullable(),
});
export type OnecEdo = z.infer<typeof OnecEdoSchema>;

export const OnecLineSchema = z.object({
  lineNo: z.number().int(),
  name: z.string(),
  material: z
    .object({ id: z.string(), code: z.string().nullable(), name: z.string() })
    .nullable(),
  unit: z.string().nullable(),
  okei: z.string().nullable(),
  /** qtyActual ?? qtyPlanned — количество, от которого считаются суммы. */
  qty: z.string().nullable(),
  qtyPlanned: z.string().nullable(),
  qtyActual: z.string().nullable(),
  /** Цена без НДС, как хранится (до 4 знаков). Справочно: опора — суммы. */
  price: MoneyString.nullable(),
  /** Только при ставке в строке; 4 знака. */
  priceWithVat: MoneyString.nullable(),
  vatRate: z.string().nullable(),
  vatRateKind: z.enum(['percent', 'zero_or_exempt', 'unknown']),
  sumExVat: MoneyString.nullable(),
  vatSum: MoneyString.nullable(),
  sumWithVat: MoneyString.nullable(),
  itemKind: z.string(),
  inventoryNumber: z.string().nullable(),
  serialNumber: z.string().nullable(),
  warnings: z.array(z.enum(['no_qty', 'no_price', 'no_vat_rate', 'no_vat_sum', 'vat_mismatch'])),
});
export type OnecLine = z.infer<typeof OnecLineSchema>;
export type OnecLineWarning = OnecLine['warnings'][number];

export const OnecTotalsSchema = z.object({
  linesTotal: z.number().int(),
  /** Строк с суммой без НДС (есть количество и цена). */
  linesWithSum: z.number().int(),
  /** Строк с НДС. */
  linesWithVat: z.number().int(),
  /** Строк, где известна сумма с НДС. complete = linesComplete = linesTotal > 0. */
  linesComplete: z.number().int(),
  /** Σ по строкам с суммой; null — ни у одной строки суммы нет. */
  sumExVat: MoneyString.nullable(),
  vatSum: MoneyString.nullable(),
  sumWithVat: MoneyString.nullable(),
  complete: z.boolean(),
});
export type OnecTotals = z.infer<typeof OnecTotalsSchema>;

export const OnecDocumentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  /** Привязан к приёмке сейчас; false — остался только в происхождении строк. */
  linked: z.boolean(),
  /** Ключ, по которому портал ищет дубли УПД: поставщик + номер + дата. */
  dedupKey: z.object({
    supplierInn: z.string().nullable(),
    number: z.string().nullable(),
    date: z.string().nullable(),
  }),
  /** Другие карточки портала с тем же dedupKey — возможные дубли, не склеены. */
  portalDuplicates: z.array(z.string()),
  supplier: OnecPartySchema,
  buyer: OnecPartySchema,
  consignee: OnecPartySchema,
  recipient: OnecRecipientSchema,
  purpose: z.string().nullable(),
  contract: OnecContractSchema.nullable(),
  /** Итоги из шапки УПД — всей УПД, а не части этой приёмки. */
  printedTotals: z.object({ totalSum: MoneyString.nullable(), vatSum: MoneyString.nullable() }),
  /** Другие приёмки с этой же УПД (общая УПД на несколько рейсов). */
  sharedWith: z.array(z.object({ id: z.string(), displayId: z.number().int() })),
  edo: z.array(OnecEdoSchema),
});
export type OnecDocument = z.infer<typeof OnecDocumentSchema>;

export const OnecGroupSchema = z.object({
  /** doc:<sourceDocumentId> | nodoc — вместе с id приёмки ключ документа 1С. */
  groupKey: z.string(),
  document: OnecDocumentSchema.nullable(),
  lines: z.array(OnecLineSchema),
  totals: OnecTotalsSchema,
});
export type OnecGroup = z.infer<typeof OnecGroupSchema>;

export const OnecExportStateSchema = z.object({
  /**
   * not_exported — 1С ещё не подтверждала; exported — у 1С текущая версия;
   * changed — у 1С другая версия; deleted — 1С применила удаление.
   */
  state: z.enum(['not_exported', 'exported', 'changed', 'deleted']),
  exportedAt: z.string().nullable(),
  exportedHash: z.string().nullable(),
  queueReason: z.enum(['changed', 'deleted', 'restored']).nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});
export type OnecExportState = z.infer<typeof OnecExportStateSchema>;

export const OnecDeliverySchema = z.object({
  id: z.string(),
  /** № приёмки в портале. */
  displayId: z.number().int(),
  status: z.string(),
  confirmedAt: z.string().nullable(),
  arrivedAt: z.string().nullable(),
  /** Только для справки: порядок версий держится последовательной обработкой. */
  snapshotAt: z.string(),
  /** Приёмка помечена на удаление (лежит в корзине портала). */
  deletion: z.object({ pendingSince: z.string() }).nullable(),
  operation: z.enum(['supply', 'transfer']),
  sourceShipmentDisplayId: z.number().int().nullable(),
  site: z.object({ code: z.string(), name: z.string(), fotSiteId: z.number().int().nullable() }),
  purpose: z.string().nullable(),
  supplier: OnecPartySchema.nullable(),
  recipient: OnecRecipientSchema,
  contract: OnecContractSchema.nullable(),
  /** УПД из ЭДО, привязанные к приёмке целиком (не к блоку документа). */
  edo: z.array(OnecEdoSchema),
  groups: z.array(OnecGroupSchema),
  totals: OnecTotalsSchema,
  contentHash: z.string(),
  hashVersion: z.number().int(),
  export: OnecExportStateSchema,
});
export type OnecDelivery = z.infer<typeof OnecDeliverySchema>;

export const OnecDeliveryBatchResponseSchema = z.object({
  snapshotAt: z.string(),
  items: z.array(OnecDeliverySchema),
  missing: z.array(z.object({ id: z.string(), state: z.enum(['deleted', 'not_found']) })),
});
export type OnecDeliveryBatchResponse = z.infer<typeof OnecDeliveryBatchResponseSchema>;

// ─────────────────────────── Очередь и подтверждение ─────────────────────

export const OnecQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
  /** Только для new: подтверждённые МОЛ раньше этого момента (ISO). */
  confirmedBefore: z.string().datetime({ offset: true }).optional(),
});

export const OnecQueueItemSchema = z.object({
  id: z.string(),
  displayId: z.number().int().nullable(),
  reason: z.enum(['new', 'changed', 'deleted', 'restored']),
  sortAt: z.string(),
  exportedHash: z.string().nullable(),
  detectedHash: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type OnecQueueItem = z.infer<typeof OnecQueueItemSchema>;

export const OnecQueueResponseSchema = z.object({
  items: z.array(OnecQueueItemSchema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  generatedAt: z.string(),
});
export type OnecQueueResponse = z.infer<typeof OnecQueueResponseSchema>;

export const OnecAckItemSchema = z.union([
  z.object({
    id: z.string().uuid(),
    contentHash: z.string(),
    hashVersion: z.number().int(),
  }),
  z.object({ id: z.string().uuid(), deleted: z.literal(true) }),
  z.object({ id: z.string().uuid(), failed: z.object({ message: z.string().min(1).max(2000) }) }),
]);
export type OnecAckItem = z.infer<typeof OnecAckItemSchema>;

export const OnecAckRequestSchema = z.object({
  items: z.array(OnecAckItemSchema).min(1).max(500),
});

export const OnecAckResultSchema = z.object({
  id: z.string(),
  result: z.enum(['ok', 'unknown_delivery', 'invalid_hash', 'unsupported_hash_version']),
});
export type OnecAckResult = z.infer<typeof OnecAckResultSchema>;

export const OnecAckResponseSchema = z.object({ results: z.array(OnecAckResultSchema) });
