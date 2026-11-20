/**
 * Объединение машин в «Документах» («Объединить в одну машину» / «Разъединить»).
 *
 * Только портал: планшет об объединении узнаёт обычной дельтой /sync — у
 * документов меняются groupId и groupRevision, новых полей и значений enum
 * мобильный контракт не получает.
 */
import { z } from 'zod';

/** Сколько документов можно выбрать для одного объединения. */
export const MACHINE_MERGE_MAX_DOCUMENTS = 50;

const documentIds = (min: number) =>
  z
    .array(z.string().uuid())
    .min(min)
    .max(MACHINE_MERGE_MAX_DOCUMENTS)
    .refine((list) => new Set(list).size === list.length, 'Документ указан дважды');

export const MachineMergeValueGroupSchema = z.object({
  value: z.string().nullable(),
  label: z.string().nullable(),
  documentIds: z.array(z.string().uuid()),
});
export type MachineMergeValueGroup = z.infer<typeof MachineMergeValueGroupSchema>;

/**
 * Почему объединять нельзя. Тот же набор возвращает предпросмотр (списком,
 * чтобы окно объяснило всё сразу) и само слияние (первый отказ, телом ответа).
 */
export const MachineMergeBlockerSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('machine_merge_disabled'), siteIds: z.array(z.string()) }),
  z.object({
    code: z.literal('tablets_not_updated'),
    sessions: z.number().int(),
    userNames: z.array(z.string()),
  }),
  z.object({ code: z.literal('groups_rollout_off') }),
  z.object({ code: z.literal('not_found'), documentIds: z.array(z.string()) }),
  z.object({ code: z.literal('not_portal_upload'), documentIds: z.array(z.string()) }),
  z.object({ code: z.literal('upload_before_rollout'), documentIds: z.array(z.string()) }),
  z.object({ code: z.literal('outbound_not_supported'), documentIds: z.array(z.string()) }),
  z.object({ code: z.literal('different_sites'), values: z.array(MachineMergeValueGroupSchema) }),
  z.object({
    code: z.literal('different_expected_dates'),
    values: z.array(MachineMergeValueGroupSchema),
  }),
  z.object({
    code: z.literal('different_suppliers'),
    values: z.array(MachineMergeValueGroupSchema),
  }),
  z.object({
    code: z.literal('different_recipients'),
    values: z.array(MachineMergeValueGroupSchema),
  }),
  z.object({
    code: z.literal('machine_has_operation'),
    deliveryNumbers: z.array(z.number().int()),
    shipments: z.number().int(),
    edoMatches: z.number().int(),
  }),
]);
export type MachineMergeBlocker = z.infer<typeof MachineMergeBlockerSchema>;

export const MachineMergeConfigResponseSchema = z.object({
  /** Объекты с включённым объединением; `['*']` — все, пусто — нигде. */
  enabledSites: z.array(z.string()),
});
export type MachineMergeConfigResponse = z.infer<typeof MachineMergeConfigResponseSchema>;

export const MachineMergePreviewRequestSchema = z.object({
  documentIds: documentIds(1),
});
export type MachineMergePreviewRequest = z.infer<typeof MachineMergePreviewRequestSchema>;

export const MachineMergePreviewResponseSchema = z.object({
  machines: z.array(
    z.object({
      headId: z.string().uuid(),
      uploads: z.array(z.object({ rootId: z.string().uuid(), uploadedAt: z.string() })),
      merged: z.boolean(),
      documents: z.array(
        z.object({
          id: z.string().uuid(),
          kind: z.string(),
          docNumber: z.string().nullable(),
          docDate: z.string().nullable(),
          status: z.string(),
          supplierName: z.string().nullable(),
        }),
      ),
    }),
  ),
  targetHeadId: z.string().uuid().nullable(),
  alreadyOneMachine: z.boolean(),
  /** Полный состав итоговой машины — его же слияние ждёт в expectedDocumentIds. */
  documentIds: z.array(z.string().uuid()),
  siteId: z.string().uuid().nullable(),
  siteName: z.string().nullable(),
  expectedDate: z.string().nullable(),
  blockers: z.array(MachineMergeBlockerSchema),
  /** Тексты отказов для окна — в том же порядке, что и blockers. */
  blockerMessages: z.array(z.string()),
  warnings: z.array(
    z.object({ code: z.literal('documents_in_progress'), count: z.number().int() }),
  ),
});
export type MachineMergePreviewResponse = z.infer<typeof MachineMergePreviewResponseSchema>;

export const MachineMergeRequestSchema = z.object({
  documentIds: documentIds(2),
  /** Состав из предпросмотра: разошёлся с текущим → 409 composition_changed. */
  expectedDocumentIds: z.array(z.string().uuid()).max(500),
});
export type MachineMergeRequest = z.infer<typeof MachineMergeRequestSchema>;

export const MachineMergeResponseSchema = z.object({
  changed: z.boolean(),
  /** Голова итоговой машины (её groupId на планшете). */
  groupId: z.string().uuid(),
  documentIds: z.array(z.string().uuid()),
  /** Операция — для «Отменить»; null, если ничего не изменилось. */
  mergeId: z.string().uuid().nullable(),
  /** «Отменить» вернёт ровно прежнее: до слияния ни одна машина не была объединённой. */
  undoable: z.boolean(),
});
export type MachineMergeResponse = z.infer<typeof MachineMergeResponseSchema>;

export const MachineUnmergeRequestSchema = z.object({
  documentId: z.string().uuid(),
  /** Состав, который видел менеджер. */
  expectedDocumentIds: z.array(z.string().uuid()).max(500),
  /** Только для «Отменить»: снять объединение, если состав создан именно этой операцией. */
  mergeId: z.string().uuid().optional(),
});
export type MachineUnmergeRequest = z.infer<typeof MachineUnmergeRequestSchema>;

export const MachineUnmergeResponseSchema = z.object({
  changed: z.boolean(),
  documentIds: z.array(z.string().uuid()),
});
export type MachineUnmergeResponse = z.infer<typeof MachineUnmergeResponseSchema>;

/** 409: состав машины изменился с момента, когда его видел менеджер. */
export const MachineCompositionChangedSchema = z.object({
  error: z.literal('composition_changed'),
  message: z.string(),
  documentIds: z.array(z.string().uuid()),
});
