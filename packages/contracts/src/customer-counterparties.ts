import { z } from 'zod';

/**
 * Вид работы подрядчика на объекте (связь «Контрагенты» × объект, миграция 0159).
 * Коды совпадают с признаком приёмки (DeliveryPurposeSchema), чтобы данные
 * можно было подставлять в «Признак» без пересчёта.
 */
export const ContractorSiteKindSchema = z.enum([
  'realization',
  'tolling_act',
  'realization_tolling',
]);
export type ContractorSiteKind = z.infer<typeof ContractorSiteKindSchema>;

export const CONTRACTOR_SITE_KIND_LABELS: Record<ContractorSiteKind, string> = {
  realization: 'Реализация',
  tolling_act: 'Давальческий',
  realization_tolling: 'Реализация + давальческий',
};

/** Данные выгрузки 1С «Списание по субподряду» по паре подрядчик × объект. */
export const CustomerCounterpartySiteOnecSchema = z.object({
  kind: ContractorSiteKindSchema,
  realizationDocs: z.number().int(),
  tollingDocs: z.number().int(),
  /** Суммы — строкой с двумя знаками; null — роли суммы не показываются. */
  realizationSum: z.string().nullable(),
  tollingSum: z.string().nullable(),
  /** Как объект назван в 1С (ПроектРодитель). */
  objects: z.array(z.string()),
  /** Когда данные загружены на портал (не дата выгрузки в 1С). */
  loadedAt: z.string(),
});
export type CustomerCounterpartySiteOnec = z.infer<typeof CustomerCounterpartySiteOnecSchema>;

export const CustomerCounterpartySiteSchema = z.object({
  siteId: z.string().uuid(),
  siteCode: z.string(),
  siteName: z.string(),
  siteActive: z.boolean(),
  /** Действующий вид: ручной, если задан, иначе по 1С. */
  kind: ContractorSiteKindSchema,
  /** Вид указан вручную в карточке. */
  manual: z.boolean(),
  onec: CustomerCounterpartySiteOnecSchema.nullable(),
});
export type CustomerCounterpartySite = z.infer<typeof CustomerCounterpartySiteSchema>;

/** Строка блока «Объекты и вид» в карточке. */
export const CustomerCounterpartySiteInputSchema = z.object({
  siteId: z.string().uuid(),
  kind: ContractorSiteKindSchema,
});
export type CustomerCounterpartySiteInput = z.infer<typeof CustomerCounterpartySiteInputSchema>;

/**
 * Справочник контрагентов заказчика (импорт из JSON-источника, миграция 0055).
 * ОТДЕЛЬНАЯ таблица `customer_counterparties`, не путать с операционной
 * `counterparties` (та завязана на FK приёмок/отгрузок и sync мобилы).
 * `inn` — свободная строка по тем же причинам, что и у поставщиков.
 *
 * `sites`/`sitesVersion` есть в ответах POST/PATCH всегда, в списке — только
 * при `?withSites=1` (страница справочника): остальные экраны, которые грузят
 * список целиком, связи с объектами не получают.
 */
export const CustomerCounterpartySchema = z.object({
  id: z.string().uuid(),
  inn: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  address: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sites: z.array(CustomerCounterpartySiteSchema).optional(),
  /** Версия связей с объектами (включая скрытые) — для правки без потери чужих изменений. */
  sitesVersion: z.string().optional(),
});
export type CustomerCounterparty = z.infer<typeof CustomerCounterpartySchema>;

export const CustomerCounterpartyUpsertSchema = z.object({
  inn: z.string().max(64).optional(),
  name: z.string().min(1).max(500),
  aliases: z.array(z.string().min(1).max(500)).max(20).optional(),
  address: z.string().max(500).nullable().optional(),
  /**
   * Полный список «объект → вид» из карточки. Без поля связи не меняются.
   * В PATCH обязателен `sitesVersion` из ответа, по которому открыта карточка:
   * если связи успели изменить — 409 `contractor_sites_conflict`.
   */
  sites: z.array(CustomerCounterpartySiteInputSchema).max(100).optional(),
  sitesVersion: z.string().max(64).optional(),
});
export type CustomerCounterpartyUpsert = z.infer<typeof CustomerCounterpartyUpsertSchema>;

export const CustomerCounterpartyListResponseSchema = z.object({
  items: z.array(CustomerCounterpartySchema),
  total: z.number(),
});
