import type { OperationSourceDocument } from '@matcheck/contracts';
import { buildItemSections } from './operationItemSections';
import { sourceKindLabel } from './sourceKindLabel';

/**
 * Позиции с пустым названием — в человеческих координатах карточки.
 *
 * Раньше такие строки молча выбрасывались при сохранении (фильтр в
 * `buildPatch`), и человек, стёрший текст, чтобы напечатать заново, терял
 * позицию целиком: количество, цену, НДС и привязку к документу. Теперь это
 * ошибка сохранения, а чтобы её можно было исправить, надо назвать строку так,
 * как её видно на экране.
 *
 * Блоки материалов свёрнуты, и подсветки строки недостаточно: пустая позиция
 * может лежать внутри закрытой панели. Поэтому адрес — «документ + номер
 * строки внутри блока», ровно та нумерация, которую показывает колонка «№».
 */
export function describeEmptyNames<
  T extends { nameRaw: string; sourceDocumentId: string | null },
>(args: { items: readonly T[]; documents: readonly OperationSourceDocument[] }): string[] {
  const sections = buildItemSections({ items: args.items, documents: args.documents });
  const hasDocuments = args.documents.length > 0;
  const found: string[] = [];

  for (const section of sections) {
    section.items.forEach((item, idx) => {
      if (item.nameRaw.trim().length > 0) return;
      found.push(`${sectionLabel(section, hasDocuments)}, строка ${idx + 1}`);
    });
  }
  return found;
}

function sectionLabel(
  section: { document: OperationSourceDocument | null; unknownDocumentId: string | null },
  hasDocuments: boolean,
): string {
  if (section.document) {
    const number = section.document.docNumber ? `№ ${section.document.docNumber}` : 'без номера';
    return `${sourceKindLabel(section.document.kind)} ${number}`;
  }
  if (section.unknownDocumentId) return `документ ${section.unknownDocumentId.slice(0, 8)}`;
  return hasDocuments ? 'без привязки к документу' : 'материалы';
}
