/**
 * Что из сообщения Диадока брать, а что пропускать.
 *
 * Чистая функция без сети и базы: именно на ней держится обещание «из ящика
 * ничего не пропадает молча», поэтому каждое решение явно названо и покрыто
 * тестами.
 *
 * Три правила, которые легко нарушить по невнимательности:
 *
 *   1. Обходим ВСЕ сущности сообщения, а не первую. Одно сообщение Диадока
 *      может нести несколько документов; прежний каркас брал первый попавшийся
 *      EntityId — остальные терялись бы без следа.
 *   2. Классифицируем по DocumentInfo (тип, функция, признаки), а не по виду
 *      вложения. Вид говорит «это файл», а не «это УПД».
 *   3. Документ, который не берём, остаётся ДОКУМЕНТОМ с причиной (`skip`), а
 *      не исчезает: в журнале видно, что счёт-фактура или акт пришли и почему
 *      их нет в портале. Молча пропускаются только подписи и прочие
 *      производные сущности — документами они не являются.
 */
import type { DiadocEntity, DiadocMessage } from './diadoc.types.js';
import { classifyDocumentMeta, type EdoMetaCategory } from './document-kind.js';
import { normalizeDocumentInfo, type EdoDocumentMeta } from './document-meta.js';

export type EntityRoute =
  /** УПД-кандидат — читаем XML напрямую, без распознавания. */
  | 'utd_xml'
  /** Скан или файл без типа — сохраняется и ждёт распознавания. */
  | 'unformalized'
  /** Документ, который не берём: счёт-фактура, акт, тестовый, аннулированный… */
  | 'skip'
  /** Не документ: подпись, производная сущность. */
  | 'ignored';

export type ClassifiedEntity = {
  entityId: string;
  route: EntityRoute;
  /** Почему именно так — попадает в журнал и отвечает на вопрос «а где документ?». */
  reason: string;
  /** Категория по метаданным; у подписей её нет. */
  category: EdoMetaCategory | null;
  typeNamedId: string | null;
  documentFunction: string | null;
  documentVersion: string | null;
  documentNumber: string | null;
  documentDate: string | null;
  fileName: string | null;
  counteragentBoxId: string | null;
  /** Зашифрованное содержимое расшифровать нечем — забирать бессмысленно. */
  isEncrypted: boolean;
  meta: EdoDocumentMeta;
};

export type ClassifiedMessage = {
  /** Сообщение целиком пропущено (исходящее, черновик, удалённое, тестовое). */
  skipped: string | null;
  entities: ClassifiedEntity[];
};

export function isSignature(entity: DiadocEntity): boolean {
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
  // Тестовый документооборот юридической силы не имеет: такие УПД в портал
  // попадать не должны, даже если выглядят настоящими.
  if (message.IsTest) return { skipped: 'тестовое сообщение', entities: [] };

  const entities = message.Entities.map((entity): ClassifiedEntity => {
    const info = entity.DocumentInfo;
    const meta = normalizeDocumentInfo(entity, message);
    const typeNamedId = info?.TypeNamedId ?? info?.DocumentType ?? null;
    const base = {
      entityId: entity.EntityId,
      typeNamedId,
      documentFunction: info?.Function ?? null,
      documentVersion: info?.Version ?? null,
      documentNumber: meta.number,
      documentDate: meta.date,
      fileName: entity.FileName ?? info?.FileName ?? null,
      counteragentBoxId: info?.CounteragentBoxId ?? null,
      isEncrypted: Boolean(info?.IsEncryptedContent),
      meta,
    };

    if (isSignature(entity)) {
      return { ...base, route: 'ignored', category: null, reason: 'подпись или производная сущность' };
    }

    const decision = classifyDocumentMeta({
      typeNamedId,
      documentFunction: base.documentFunction,
      isTest: meta.isTest,
      revoked: meta.revoked,
      isDeleted: meta.isDeleted,
      // Направление проверяем по самому документу, а не только по ящикам: в
      // одном сообщении встречаются документы обеих сторон.
      outbound: Boolean(info?.DocumentDirection && /outbound/i.test(info.DocumentDirection)),
      encrypted: base.isEncrypted,
    });

    const route: EntityRoute =
      decision.category === 'utd_candidate'
        ? 'utd_xml'
        : decision.category === 'scan'
          ? 'unformalized'
          : 'skip';
    return { ...base, route, category: decision.category, reason: decision.reason };
  });

  return { skipped: null, entities };
}
