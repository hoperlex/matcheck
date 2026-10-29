// Парный delivery для межобъектного перемещения (shipment.kind='transfer').
//
// При оформлении transfer'a инспектор объекта-источника создаёт shipment,
// а сервер автоматически «зеркалит» документ в виде ожидаемой приёмки на
// объекте-получателе. Инспектор destSiteId видит этот delivery в обычном
// списке приёмок и принимает его тем же потоком, что и приёмки по УПД.
//
// Идемпотентность — по deliveries.source_shipment_id (UNIQUE partial-index).
// Повторные PATCH'ы исходного shipment не плодят новых deliveries.
//
// При первичном создании копируем позиции shipment в delivery (включая
// item_kind/asset_id/inventory_number/serial_number). При повторных вызовах
// позиции и arrived_at парного delivery НЕ перезаписываются — инспектор
// destSiteId мог уже начать заполнение фактических количеств.

import { eq } from 'drizzle-orm';
import {
  deliveries,
  deliveryItems,
  shipments,
  shipmentItems,
} from '../../db/schema.js';
import { resolveStatusId } from '../statuses/lookup.js';
import { lockPurposeForRecipientWrite, purposeOnInsert } from '../operations/delivery-purpose.js';

/**
 * Синхронизирует парный delivery для shipment.kind='transfer'.
 * Вызывается после успешного create/update shipment в той же транзакции.
 * Для shipment'ов другого kind — no-op.
 */
export async function syncPairedTransferDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  shipmentId: string,
): Promise<void> {
  const [sh] = await app.db
    .select()
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  if (!sh || sh.kind !== 'transfer') return;
  if (!sh.destSiteId) return; // защита: CHECK не должен пускать, но на всякий случай

  const [existing] = await app.db
    .select()
    .from(deliveries)
    .where(eq(deliveries.sourceShipmentId, shipmentId))
    .limit(1);

  if (!existing) {
    // Первичное создание: статус not_filled, позиции — копия из shipment.
    const statusId = await resolveStatusId(app, 'delivery', 'not_filled');
    const [created] = await app.db
      .insert(deliveries)
      .values({
        statusId,
        siteId: sh.destSiteId,
        supplierId: null,
        contractorId: sh.receiverCounterpartyId,
        recipientMolId: sh.receiverMolId,
        purpose: purposeOnInsert({
          contractorId: sh.receiverCounterpartyId,
          recipientMolId: sh.receiverMolId,
        }),
        sourceShipmentId: sh.id,
        vehiclePlate: sh.vehiclePlate,
        driverName: sh.driverName,
        // arrivedAt оставляем NULL — фактическую дату прибытия проставляет
        // инспектор destSiteId при приёмке.
        arrivedAt: null,
        comment: null,
        version: 1,
      })
      .returning();
    if (!created) throw new Error('Failed to create paired delivery for transfer');

    const items = await app.db
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, sh.id))
      .orderBy(shipmentItems.lineNo);
    if (items.length) {
      await app.db.insert(deliveryItems).values(
        items.map((i: typeof shipmentItems.$inferSelect) => ({
          deliveryId: created.id,
          itemKind: i.itemKind,
          materialId: i.materialId,
          assetId: i.assetId,
          inventoryNumber: i.inventoryNumber,
          serialNumber: i.serialNumber,
          nameRaw: i.nameRaw,
          // План = факт отгрузки. Факт прибытия (qtyActual) заполнит инспектор destSite.
          qtyPlanned: i.qtyActual ?? i.qtyPlanned,
          qtyActual: null,
          unit: i.unit,
          comment: i.comment,
          lineNo: i.lineNo,
          volumeM3: i.volumeM3,
          massKg: i.massKg,
          volumeConfidence: i.volumeConfidence,
          groupName: i.groupName,
        })),
      );
    }
    return;
  }

  // Парный delivery уже есть — обновляем только верхний уровень.
  // Позиции и arrived_at не перетираем, чтобы не сбрасывать прогресс
  // инспектора destSiteId.
  // Получатель меняется — признак пересчитывается под блокировкой строки, как
  // в upsert приёмки (domain/operations/delivery-purpose.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.db.transaction(async (tx: any) => {
    const next = {
      contractorId: sh.receiverCounterpartyId,
      recipientMolId: sh.receiverMolId,
    };
    const reconciled = await lockPurposeForRecipientWrite(tx, existing.id, next);
    await tx
      .update(deliveries)
      .set({
        ...next,
        ...(reconciled && { purpose: reconciled.purpose }),
        vehiclePlate: sh.vehiclePlate,
        driverName: sh.driverName,
        updatedAt: new Date(),
      })
      .where(eq(deliveries.id, existing.id));
  });
}
