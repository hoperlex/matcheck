/**
 * Разбор ответов Диадока.
 *
 * Схемы намеренно ТЕРПИМЫЕ: незнакомые поля пропускаются, а почти всё, кроме
 * идентификаторов, объявлено необязательным. Причина простая — API живой и
 * развивается, а проход не должен падать из-за поля, которое добавили на той
 * стороне. Жёсткость здесь означала бы, что новый атрибут в сообщении
 * останавливает приём документов.
 *
 * Точная форма ответов фиксируется фикстурами на этапе разведки (Э1): до
 * первого реального ответа часть имён — обоснованное предположение по
 * документации, а не факт.
 */
import { z } from 'zod';

/** Дата-время Диадока приходит тиками .NET либо ISO-строкой. */
export const DiadocTimestampSchema = z.union([z.string(), z.number()]);

export const DiadocDocumentInfoSchema = z
  .object({
    // Идентификаторы.
    MessageId: z.string().optional(),
    EntityId: z.string().optional(),
    DocumentId: z.string().optional(),
    // Классификация.
    DocumentType: z.string().optional(),
    TypeNamedId: z.string().optional(),
    Function: z.string().optional(),
    Version: z.string().optional(),
    DocumentDirection: z.string().optional(),
    // Реквизиты для журнала.
    DocumentNumber: z.string().optional(),
    DocumentDate: z.string().optional(),
    CounteragentBoxId: z.string().optional(),
    FileName: z.string().optional(),
    TotalSum: z.union([z.string(), z.number()]).optional(),
    // Состояния, из-за которых документ нельзя или не нужно забирать.
    IsDeleted: z.boolean().optional(),
    IsEncryptedContent: z.boolean().optional(),
    IsTest: z.boolean().optional(),
    SenderSignatureStatus: z.string().optional(),
    RevocationStatus: z.string().optional(),
  })
  .passthrough();
export type DiadocDocumentInfo = z.infer<typeof DiadocDocumentInfoSchema>;

export const DiadocEntitySchema = z
  .object({
    EntityId: z.string(),
    EntityType: z.string().optional(),
    AttachmentType: z.string().optional(),
    // У подписи и прочих производных сущностей родитель заполнен; титул
    // продавца — сущность без родителя.
    ParentEntityId: z.string().optional(),
    FileName: z.string().optional(),
    NeedRecipientSignature: z.boolean().optional(),
    DocumentInfo: DiadocDocumentInfoSchema.optional(),
    Content: z
      .object({ Size: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type DiadocEntity = z.infer<typeof DiadocEntitySchema>;

export const DiadocMessageSchema = z
  .object({
    MessageId: z.string(),
    FromBoxId: z.string().optional(),
    ToBoxId: z.string().optional(),
    Timestamp: DiadocTimestampSchema.optional(),
    IsDraft: z.boolean().optional(),
    IsDeleted: z.boolean().optional(),
    IsTest: z.boolean().optional(),
    Entities: z.array(DiadocEntitySchema).default([]),
  })
  .passthrough();
export type DiadocMessage = z.infer<typeof DiadocMessageSchema>;

/**
 * Событие ленты. Может нести сообщение целиком либо патч к уже доставленному —
 * и патч вполне может не содержать нового документа. Ровно поэтому журнал
 * событий отделён от журнала вложений.
 */
export const DiadocBoxEventSchema = z
  .object({
    EventId: z.string(),
    IndexKey: z.string().optional(),
    Timestamp: DiadocTimestampSchema.optional(),
    Message: DiadocMessageSchema.optional(),
    Patch: z
      .object({ MessageId: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type DiadocBoxEvent = z.infer<typeof DiadocBoxEventSchema>;

export const DiadocBoxEventListSchema = z
  .object({
    Events: z.array(DiadocBoxEventSchema).default([]),
    TotalCount: z.number().optional(),
  })
  .passthrough();

export const DiadocOrganizationSchema = z
  .object({
    OrgId: z.string().optional(),
    Inn: z.string().optional(),
    Kpp: z.string().optional(),
    FullName: z.string().optional(),
    ShortName: z.string().optional(),
    Boxes: z
      .array(
        z
          .object({
            BoxId: z.string(),
            Title: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export const DiadocOrganizationListSchema = z
  .object({ Organizations: z.array(DiadocOrganizationSchema).default([]) })
  .passthrough();

export const DiadocEmployeeSchema = z
  .object({
    IsBlocked: z.boolean().optional(),
    Permissions: z
      .object({
        DocumentAccessLevel: z.string().optional(),
        CanSignDocuments: z.boolean().optional(),
        IsAdministrator: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    // У части ответов уровень доступа лежит плоско, а не внутри Permissions.
    DocumentAccessLevel: z.string().optional(),
  })
  .passthrough();
export type DiadocEmployee = z.infer<typeof DiadocEmployeeSchema>;

/**
 * Приводит время Диадока к Date.
 *
 * Тики .NET считаются от 0001-01-01, поэтому «просто число» интерпретировать
 * как миллисекунды Unix нельзя — получится первое января 1970 года плюс
 * копейки, то есть дата документа уедет на два тысячелетия.
 */
const TICKS_AT_UNIX_EPOCH = 621_355_968_000_000_000n;

export function diadocTimestampToDate(value: string | number | undefined): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d{15,}$/.test(String(value))) {
    const ticks = BigInt(value);
    const ms = (ticks - TICKS_AT_UNIX_EPOCH) / 10_000n;
    const asNumber = Number(ms);
    return Number.isFinite(asNumber) ? new Date(asNumber) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** Обратное преобразование: отсечку первичной загрузки Диадок ждёт тиками. */
export function dateToDiadocTicks(date: Date): string {
  return String(BigInt(date.getTime()) * 10_000n + TICKS_AT_UNIX_EPOCH);
}
