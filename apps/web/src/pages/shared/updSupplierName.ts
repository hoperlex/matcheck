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
