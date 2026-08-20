/**
 * След документа в операциях: можно ли править его состав машиной.
 *
 * Отдельный модуль, а не функция внутри скрипта: правило «когда документ трогать
 * нельзя» понадобится любому коду, который меняет позиции задним числом, и
 * второй копии у него быть не должно.
 */
import { eq, inArray, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { db } from '../../db/client.js';
import {
  deliveries,
  deliveryItems,
  deliverySources,
  shipmentItems,
  shipments,
  shipmentSources,
} from '../../db/schema.js';

type Db = typeof db;

/**
 * Оставил ли документ след в операциях — и какой.
 *
 * Проверять только `delivery_sources` мало. Привязка документа к приёмке и
 * происхождение её позиций живут в РАЗНЫХ местах: `POST /deliveries/:id/
 * unlink-source` снимает первое и намеренно НЕ трогает второе. После такой
 * отвязки документ выглядит свободным, хотя его строки уже перенесены в
 * проведённую приёмку — а у `delivery_items.source_document_item_id` стоит
 * ON DELETE SET NULL, то есть удаление строки не упрётся в БД, а молча
 * обнулит происхождение позиции.
 *
 * Возвращает человекочитаемую причину или null, если след не найден.
 */
export async function operationTrace(
  tx: Db,
  documentId: string,
  itemIds: string[],
): Promise<string | null> {
  const [srcDelivery] = await tx
    .select({ displayId: deliveries.displayId })
    .from(deliverySources)
    .innerJoin(deliveries, eq(deliveries.id, deliverySources.deliveryId))
    .where(eq(deliverySources.sourceDocumentId, documentId))
    .limit(1);
  if (srcDelivery) return `документ привязан к приёмке #${srcDelivery.displayId}`;

  const [srcShipment] = await tx
    .select({ displayId: shipments.displayId })
    .from(shipmentSources)
    .innerJoin(shipments, eq(shipments.id, shipmentSources.shipmentId))
    .where(eq(shipmentSources.sourceDocumentId, documentId))
    .limit(1);
  if (srcShipment) return `документ привязан к отгрузке #${srcShipment.displayId}`;

  const itemFilter = (docCol: AnyPgColumn, itemCol: AnyPgColumn) =>
    itemIds.length > 0
      ? or(eq(docCol, documentId), inArray(itemCol, itemIds))!
      : eq(docCol, documentId);

  const [itemDelivery] = await tx
    .select({ displayId: deliveries.displayId })
    .from(deliveryItems)
    .innerJoin(deliveries, eq(deliveries.id, deliveryItems.deliveryId))
    .where(itemFilter(deliveryItems.sourceDocumentId, deliveryItems.sourceDocumentItemId))
    .limit(1);
  if (itemDelivery) {
    return `строки документа уже перенесены в приёмку #${itemDelivery.displayId}`;
  }

  const [itemShipment] = await tx
    .select({ displayId: shipments.displayId })
    .from(shipmentItems)
    .innerJoin(shipments, eq(shipments.id, shipmentItems.shipmentId))
    .where(itemFilter(shipmentItems.sourceDocumentId, shipmentItems.sourceDocumentItemId))
    .limit(1);
  if (itemShipment) {
    return `строки документа уже перенесены в отгрузку #${itemShipment.displayId}`;
  }
  return null;
}
