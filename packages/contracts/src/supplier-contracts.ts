import { z } from 'zod';

/**
 * Договоры с контрагентами из 1С (выгрузка «группа Снабжение») и договор приёмки.
 * Справочник пишет только CLI scripts/import-contracts.ts; портал его читает и
 * даёт выбрать один договор на приёмку (кнопка «+ Договор» в карточке).
 */

export const SupplierContractKindSchema = z.enum(['supplier', 'buyer', 'other']);
export type SupplierContractKind = z.infer<typeof SupplierContractKindSchema>;

/**
 * Как определён объект договора по тексту:
 *  - exact — один объект;
 *  - group — законная группа объектов (ЗИЛАРТ без лота → ЗИЛ18 и ЗИЛ33);
 *  - conflict — правила противоречат друг другу (адрес одного объекта, номер другого);
 *  - none — объект в тексте не найден (распред. письма, счета без адреса).
 */
export const SupplierContractSiteStatusSchema = z.enum(['exact', 'group', 'conflict', 'none']);
export type SupplierContractSiteStatus = z.infer<typeof SupplierContractSiteStatusSchema>;

/**
 * Объект договора относительно объекта приёмки:
 *  - match — объект определён точно и совпал;
 *  - group — объект приёмки входит в группу договора;
 *  - conflict — объект спорный, объект приёмки среди претендентов (не «зелёный»);
 *  - unknown — объект договора не определён;
 *  - other — договор другого объекта (или спорный без объекта приёмки).
 */
export const ContractSiteMatchSchema = z.enum(['match', 'group', 'conflict', 'unknown', 'other']);
export type ContractSiteMatch = z.infer<typeof ContractSiteMatchSchema>;

export const SupplierContractSummarySchema = z.object({
  id: z.string().uuid(),
  onecId: z.string().uuid(),
  counterpartyName: z.string(),
  counterpartyInn: z.string(),
  name: z.string(),
  number: z.string().nullable(),
  /** YYYY-MM-DD или null (в 1С пусто или дата битая). */
  contractDate: z.string().nullable(),
  kind: SupplierContractKindSchema,
  objectText: z.string().nullable(),
  siteStatus: SupplierContractSiteStatusSchema,
  /** Коды объектов договора (при conflict — все претенденты). */
  siteCodes: z.array(z.string()),
  /** Договора нет в последней выгрузке 1С с этой даты. */
  missingSince: z.string().nullable(),
});
export type SupplierContractSummary = z.infer<typeof SupplierContractSummarySchema>;

/** Сводка справочника: сколько договоров и когда загружен действующий импорт. */
export const SupplierContractCatalogInfoSchema = z.object({
  total: z.number().int(),
  importedAt: z.string().nullable(),
});
export type SupplierContractCatalogInfo = z.infer<typeof SupplierContractCatalogInfoSchema>;

/**
 * Договор приёмки. Флаги пересчитываются при каждом запросе по актуальным ИНН
 * документов приёмки. supplierMatch: null — ИНН поставщика приёмки неизвестен.
 */
export const DeliveryContractSchema = SupplierContractSummarySchema.extend({
  linkedAt: z.string(),
  linkedByName: z.string().nullable(),
  supplierMatch: z.boolean().nullable(),
  siteMatch: ContractSiteMatchSchema,
  /** Вид договора в 1С уже не «С поставщиком» (сменился после выбора). */
  kindChanged: z.boolean(),
  missing: z.boolean(),
});
export type DeliveryContract = z.infer<typeof DeliveryContractSchema>;

/** Свой договор документа (режим «Разные получатели по документам»). */
export const DeliveryDocumentContractSchema = z.object({
  documentId: z.string().uuid(),
  contract: DeliveryContractSchema,
});
export type DeliveryDocumentContract = z.infer<typeof DeliveryDocumentContractSchema>;

export const DeliveryContractResponseSchema = z.object({
  /** Общий договор приёмки. */
  contract: DeliveryContractSchema.nullable(),
  /** Включён ли режим «Разные получатели по документам». */
  perDocument: z.boolean(),
  /**
   * Документы со своим договором. Документ без своего договора наследует общий.
   * Флаги договора документа считаются по ИНН поставщика этого документа.
   */
  documents: z.array(DeliveryDocumentContractSchema),
  catalog: SupplierContractCatalogInfoSchema,
});
export type DeliveryContractResponse = z.infer<typeof DeliveryContractResponseSchema>;

export const ContractCandidatesQuerySchema = z.object({
  /** Подбор для документа приёмки (по ИНН его поставщика); без него — общий договор. */
  documentId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  /** 1 — все поставщики, а не только поставщик приёмки. */
  allSuppliers: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ContractCandidatesQuery = z.infer<typeof ContractCandidatesQuerySchema>;

export const ContractCandidateSchema = SupplierContractSummarySchema.extend({
  supplierMatch: z.boolean().nullable(),
  siteMatch: ContractSiteMatchSchema,
  missing: z.boolean(),
  /** Это текущий договор приёмки. */
  current: z.boolean(),
});
export type ContractCandidate = z.infer<typeof ContractCandidateSchema>;

export const ContractCandidatesContextSchema = z.object({
  /** Документ, для которого подбор; null — общий договор приёмки. */
  documentId: z.string().uuid().nullable(),
  /** ИНН поставщика приёмки или документа (без своих ИНН). */
  supplierInns: z.array(z.string()),
  supplierKnown: z.boolean(),
  /** Фильтр по поставщику фактически применён (ИНН известен и не «Все поставщики»). */
  filteredBySupplier: z.boolean(),
  siteCode: z.string().nullable(),
  /** Сколько договоров поставщика приёмки в справочнике (вид «С поставщиком»). */
  supplierContractsTotal: z.number().int(),
  importedAt: z.string().nullable(),
});
export type ContractCandidatesContext = z.infer<typeof ContractCandidatesContextSchema>;

export const ContractCandidatesResponseSchema = z.object({
  items: z.array(ContractCandidateSchema),
  total: z.number().int(),
  context: ContractCandidatesContextSchema,
});
export type ContractCandidatesResponse = z.infer<typeof ContractCandidatesResponseSchema>;

/**
 * Выбрать или заменить договор приёмки. replaceContractId — договор, который
 * пользователь видел в момент подтверждения (null — договора не было). Если на
 * сервере уже другой — 409 contract_changed, тихой перезаписи нет.
 */
export const SetDeliveryContractBodySchema = z.object({
  /** Договор документа (режим «Разные получатели»); null/нет — общий договор приёмки. */
  documentId: z.string().uuid().nullable().optional(),
  contractId: z.string().uuid(),
  replaceContractId: z.string().uuid().nullable(),
});
export type SetDeliveryContractBody = z.infer<typeof SetDeliveryContractBodySchema>;

export const UnsetDeliveryContractQuerySchema = z.object({
  expectedContractId: z.string().uuid(),
  /** Договор документа; без него — общий договор приёмки. */
  documentId: z.string().uuid().optional(),
});
export type UnsetDeliveryContractQuery = z.infer<typeof UnsetDeliveryContractQuerySchema>;

/** 409: договор приёмки успел поменять другой пользователь. */
export const DeliveryContractChangedSchema = z.object({
  error: z.literal('contract_changed'),
  message: z.string(),
  current: DeliveryContractSchema.nullable(),
});
export type DeliveryContractChanged = z.infer<typeof DeliveryContractChangedSchema>;

// ─── Вкладка «Договоры» в Справочниках ──────────────────────────────────────

export const SupplierContractsListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  siteId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SupplierContractsListQuery = z.infer<typeof SupplierContractsListQuerySchema>;

export const SupplierContractsListResponseSchema = z.object({
  items: z.array(SupplierContractSummarySchema),
  total: z.number().int(),
  importedAt: z.string().nullable(),
});
export type SupplierContractsListResponse = z.infer<typeof SupplierContractsListResponseSchema>;
