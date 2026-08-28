import type { OperationSourceDocument } from '@matcheck/contracts';

/**
 * Разбиение материалов операции на блоки «по документу».
 *
 * В поставке бывает несколько документов, и менеджеру нужно видеть, чьи это
 * строки. Блоки строятся так, чтобы не потерялись ни документ, ни строка:
 *
 *  1. пустые блоки по всем документам операции — связанный документ без
 *     распознанных позиций обязан быть виден («(0)»), иначе он исчезает из
 *     карточки целиком;
 *  2. по ним раскладываются позиции;
 *  3. блоки для документов, на которые ссылаются строки, но которых нет в
 *     сводке (офлайн-снимок от /sync поля sourceDocuments не содержит);
 *  4. последним — блок строк без происхождения.
 *
 * Инвариант: сумма длин блоков равна числу входных строк. Сохранение устроено
 * как DELETE + INSERT всего списка, поэтому потерянная при группировке строка
 * означала бы потерю данных в БД.
 */

export const NO_DOCUMENT_SECTION_KEY = '__none__';

export type ItemSection<T> = {
  /** id документа либо NO_DOCUMENT_SECTION_KEY — ключ панели Collapse. */
  key: string;
  /** Сводка документа; null — строки без происхождения или документ вне сводки. */
  document: OperationSourceDocument | null;
  /** id документа, которого нет в сводке (шаг 3). */
  unknownDocumentId: string | null;
  items: T[];
};

export function buildItemSections<T extends { sourceDocumentId: string | null }>(args: {
  items: readonly T[];
  documents: readonly OperationSourceDocument[];
}): ItemSection<T>[] {
  const { items, documents } = args;

  const sections: ItemSection<T>[] = documents.map((document) => ({
    key: document.id,
    document,
    unknownDocumentId: null,
    items: [],
  }));
  const byKey = new Map(sections.map((s) => [s.key, s]));

  const noDocument: ItemSection<T> = {
    key: NO_DOCUMENT_SECTION_KEY,
    document: null,
    unknownDocumentId: null,
    items: [],
  };
  const unknown: ItemSection<T>[] = [];

  for (const item of items) {
    const docId = item.sourceDocumentId;
    if (docId === null) {
      noDocument.items.push(item);
      continue;
    }
    const known = byKey.get(docId);
    if (known) {
      known.items.push(item);
      continue;
    }
    let section = unknown.find((s) => s.key === docId);
    if (!section) {
      section = { key: docId, document: null, unknownDocumentId: docId, items: [] };
      unknown.push(section);
      byKey.set(docId, section);
    }
    section.items.push(item);
  }

  // Блок «без привязки» показываем, когда в нём есть строки, а также когда
  // документов нет вовсе: приёмка без УПД должна остаться с одним блоком
  // «Материалы», в который добавляются ручные строки.
  const tail = noDocument.items.length > 0 || documents.length === 0 ? [noDocument] : [];
  return [...sections, ...unknown, ...tail];
}
