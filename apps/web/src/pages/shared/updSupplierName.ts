import { normalizeInn } from '../../shared/utils/inn';

/**
 * Имя поставщика из привязанного документа — для чипа «Поставщик» в шапке
 * приёмки и отгрузки.
 *
 * У распознанного УПД поставщик лежит в source_documents.supplier_directory_id,
 * а deliveries.supplier_id при привязке никто не заполняет (ручной выбор при
 * этом закрыт: сервер отвечает upd_takes_priority). Таблица списка давно берёт
 * имя из документа (resolveSupplierName в DeliveriesHistory), а карточка
 * смотрела только на собственные поля операции и показывала «— из УПД —».
 *
 * Документ учитывается, только пока он привязан к операции. Карточка держит
 * его в local state, и после отвязки он там остаётся: без этой проверки чип,
 * ставший редактируемым, показал бы поставщика чужого документа, хотя у самой
 * операции поставщик пуст. То же у черновика: документ уже выбран, а
 * sourceDocumentIds ещё пуст.
 */
export function pickUpdSupplierName(
  doc: { id: string; supplierName?: string | null } | null | undefined,
  linkedIds: readonly string[],
): string | null {
  if (!doc || !linkedIds.includes(doc.id)) return null;
  const name = doc.supplierName?.trim();
  return name ? name : null;
}

/** Документ, поставщика которого можно поправить из чипа операции. */
export type UpdSupplierEditTarget = {
  docId: string;
  docNumber: string | null;
  docDate: string | null;
  /** Сколько документов привязано к операции — для предупреждения в окне. */
  linkedCount: number;
  /**
   * Проверенный ИНН поставщика из самого документа или null, если он неизвестен.
   * По нему окно ставит первой запись «ИНН как в документе» и переспрашивает,
   * когда выбирают запись с другим ИНН. См. documentSupplierInn.
   */
  docInn: string | null;
};

/** След проверки ИНН поставщика — те поля, что нужны окну. */
type SupplierInnTrace = { decision: string; inn: string | null };

/**
 * ИНН поставщика, напечатанный в документе, — только из следа проверки ИНН.
 *
 * Не из supplierInn документа: ручная правка поставщика обнуляет
 * supplier_inn_raw, и API подставляет ИНН выбранной записи. После ошибочной
 * перепривязки (приёмка 21713: дубль с ИНН 5028024698 вместо 5028021698) такой
 * «документный» ИНН подтверждал бы ошибку. След правкой не стирается.
 *
 * Нет следа (документы до 22.10, SUPPLIER_INN_CHECK=off) или ИНН не прошёл
 * проверку — null: окно ведёт себя как раньше, без догадок.
 */
export function documentSupplierInn(trace: SupplierInnTrace | null | undefined): string | null {
  if (!trace) return null;
  if (
    trace.decision !== 'valid' &&
    trace.decision !== 'normalized' &&
    trace.decision !== 'corrected'
  ) {
    return null;
  }
  return normalizeInn(trace.inn);
}

/**
 * Какой документ правит чип «Поставщик», если к операции привязан УПД, — или
 * null, если править нечего.
 *
 * Только основной документ (sourceDocumentIds[0]): поставщика именно его
 * показывают и чип, и строка списка (primarySourceDocument). Правка любого
 * другого не была бы видна нигде, поэтому выбора документа нет.
 *
 * Собственный поставщик операции стоит в цепочке имени чипа выше документа:
 * правка документа его не сменила бы, и чип показал бы прежнее имя.
 *
 * Документ из local state должен быть текущим основным: после отвязки или
 * смены основного карточка ещё держит прежний, и правка ушла бы не туда.
 */
export function updSupplierEditTarget({
  sourceDocumentIds,
  ownSupplierId,
  selectedUpd,
  canEdit,
}: {
  sourceDocumentIds: readonly string[];
  ownSupplierId: string | null | undefined;
  selectedUpd:
    | {
        id: string;
        docNumber?: string | null;
        docDate?: string | null;
        supplierInnCheck?: SupplierInnTrace | null;
      }
    | null
    | undefined;
  canEdit: boolean;
}): UpdSupplierEditTarget | null {
  if (!canEdit || ownSupplierId) return null;
  if (!selectedUpd || sourceDocumentIds[0] !== selectedUpd.id) return null;
  return {
    docId: selectedUpd.id,
    docNumber: selectedUpd.docNumber ?? null,
    docDate: selectedUpd.docDate ?? null,
    linkedCount: sourceDocumentIds.length,
    docInn: documentSupplierInn(selectedUpd.supplierInnCheck),
  };
}
