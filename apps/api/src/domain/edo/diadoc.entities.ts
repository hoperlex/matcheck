/**
 * Что из сообщения Диадока брать, а что пропускать.
 *
 * Чистая функция без сети и базы: именно на ней держится обещание «из ящика
 * ничего не пропадает молча», поэтому каждое решение явно названо и покрыто
 * тестами.
 *
 * Два правила, которые легко нарушить по невнимательности:
 *
 *   1. Обходим ВСЕ сущности сообщения, а не первую. Одно сообщение Диадока
 *      может нести несколько документов; прежний каркас брал первый попавшийся
 *      EntityId — остальные терялись бы без следа.
 *   2. Классифицируем по DocumentInfo (тип, функция, версия, направление), а не
 *      по виду вложения. Вид говорит «это файл», а не «это УПД».
 */
import type { DiadocEntity, DiadocMessage } from './diadoc.types.js';

/** Формализованный УПД: его титул продавца и есть машиночитаемый документ. */
const UTD_TYPE_NAMED_IDS = new Set([
  'UniversalTransferDocument',
  'UniversalTransferDocumentRevision',
]);

export type EntityRoute =
  /** Формализованный УПД — читаем XML напрямую, без распознавания. */
  | 'utd_xml'
  /** Неформализованный файл — в существующий конвейер распознавания. */
  | 'unformalized'
  /** Брать нечего: подпись, служебное, исходящее, удалённое. */
  | 'ignored';

export type ClassifiedEntity = {
  entityId: string;
  route: EntityRoute;
  /** Почему именно так — попадает в журнал и отвечает на вопрос «а где документ?». */
  reason: string;
  typeNamedId: string | null;
  documentFunction: string | null;
  documentVersion: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  fileName: string | null;
  counteragentBoxId: string | null;
  /** Зашифрованное содержимое расшифровать нечем — забирать бессмысленно. */
  isEncrypted: boolean;
};

export type ClassifiedMessage = {
  /** Сообщение целиком пропущено (исходящее, черновик, удалённое). */
  skipped: string | null;
  entities: ClassifiedEntity[];
};

function isSignature(entity: DiadocEntity): boolean {
  if (entity.EntityType && /signature/i.test(entity.EntityType)) return true;
  if (entity.AttachmentType && /signature/i.test(entity.AttachmentType)) return true;
  // Подпись и прочие производные сущности привязаны к родителю; титул продавца
  // родителя не имеет.
  return Boolean(entity.ParentEntityId);
}

export function classifyMessageEntities(
  message: DiadocMessage,
  ourBoxId: string,
): ClassifiedMessage {
  // Исходящее не наше дело: интеграция читает только входящие.
  if (message.FromBoxId && message.FromBoxId === ourBoxId) {
    return { skipped: 'исходящее сообщение', entities: [] };
  }
  if (message.ToBoxId && message.ToBoxId !== ourBoxId) {
    return { skipped: 'сообщение адресовано другому ящику', entities: [] };
  }
  if (message.IsDraft) return { skipped: 'черновик', entities: [] };
  if (message.IsDeleted) return { skipped: 'сообщение удалено', entities: [] };

  const entities = message.Entities.map((entity): ClassifiedEntity => {
    const info = entity.DocumentInfo;
    const typeNamedId = info?.TypeNamedId ?? info?.DocumentType ?? null;
    const base = {
      entityId: entity.EntityId,
      typeNamedId,
      documentFunction: info?.Function ?? null,
      documentVersion: info?.Version ?? null,
      documentNumber: info?.DocumentNumber ?? null,
      documentDate: info?.DocumentDate ?? null,
      fileName: entity.FileName ?? info?.FileName ?? null,
      counteragentBoxId: info?.CounteragentBoxId ?? null,
      isEncrypted: Boolean(info?.IsEncryptedContent),
    };

    if (isSignature(entity)) {
      return { ...base, route: 'ignored', reason: 'подпись или производная сущность' };
    }
    if (info?.IsDeleted) {
      return { ...base, route: 'ignored', reason: 'документ удалён' };
    }
    // Направление проверяем по самому документу, а не только по ящикам: в одном
    // сообщении встречаются документы обеих сторон.
    if (info?.DocumentDirection && /outbound/i.test(info.DocumentDirection)) {
      return { ...base, route: 'ignored', reason: 'исходящий документ' };
    }
    if (base.isEncrypted) {
      // Ключа у нас нет и не будет: забирать шифротекст незачем, но факт
      // фиксируем — иначе документ выглядел бы пропавшим.
      return { ...base, route: 'ignored', reason: 'содержимое зашифровано' };
    }

    if (typeNamedId && UTD_TYPE_NAMED_IDS.has(typeNamedId)) {
      return { ...base, route: 'utd_xml', reason: 'формализованный УПД' };
    }

    return {
      ...base,
      route: 'unformalized',
      reason: typeNamedId
        ? `неформализованный документ (${typeNamedId})`
        : 'вложение без типа документа',
    };
  });

  return { skipped: null, entities };
}
