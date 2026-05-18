/**
 * Orphan-cleanup для фото: записи в delivery_photos / shipment_photos
 * создаются ДО PUT в S3 (в POST /photos/presign). Если клиент не выполнит
 * PUT или не дойдёт до POST /photos/{id}/confirm — запись остаётся
 * незакрытой (uploaded_at IS NULL). Эта job раз в час чистит такие
 * записи: для каждой делает S3.HEAD, и
 *   - если объект есть → проставляет uploaded_at = now() (clock drift /
 *     клиент не вызвал confirm);
 *   - если нет → удаляет запись из БД (S3-объекта так и не появилось).
 *
 * Подключение: вызывается из apps/api/src/worker.ts через setInterval
 * с интервалом 1 час. Время первого запуска — после 5 мин от старта
 * процесса (даём клиентам, висевшим на старом presign-URL, время
 * подтвердить).
 */
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from '../../db/client.js';
import { deliveryPhotos, shipmentPhotos } from '../../db/schema.js';
import { headObject } from '../storage/s3.signer.js';

// Запись считается orphan'ом если taken_at старше этой границы И uploaded_at
// до сих пор null. 1 час даёт WorkManager на Android несколько попыток
// confirm даже при отсутствии сети.
const ORPHAN_THRESHOLD_MS = 60 * 60 * 1000;

type CleanupStats = {
  checked: number;
  confirmed: number;
  deleted: number;
  errors: number;
};

export async function cleanupPhotoOrphans(log: Logger): Promise<CleanupStats> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS);
  const stats: CleanupStats = { checked: 0, confirmed: 0, deleted: 0, errors: 0 };

  const deliveryOrphans = await db
    .select({ id: deliveryPhotos.id, s3Key: deliveryPhotos.s3Key })
    .from(deliveryPhotos)
    .where(and(isNull(deliveryPhotos.uploadedAt), lt(deliveryPhotos.takenAt, cutoff)));

  for (const p of deliveryOrphans) {
    stats.checked++;
    try {
      const exists = await headObject(p.s3Key);
      if (exists) {
        await db
          .update(deliveryPhotos)
          .set({ uploadedAt: new Date() })
          .where(eq(deliveryPhotos.id, p.id));
        stats.confirmed++;
      } else {
        await db.delete(deliveryPhotos).where(eq(deliveryPhotos.id, p.id));
        stats.deleted++;
      }
    } catch (err) {
      log.warn({ err, s3Key: p.s3Key }, 'photo orphan cleanup: S3 HEAD failed');
      stats.errors++;
    }
  }

  const shipmentOrphans = await db
    .select({ id: shipmentPhotos.id, s3Key: shipmentPhotos.s3Key })
    .from(shipmentPhotos)
    .where(and(isNull(shipmentPhotos.uploadedAt), lt(shipmentPhotos.takenAt, cutoff)));

  for (const p of shipmentOrphans) {
    stats.checked++;
    try {
      const exists = await headObject(p.s3Key);
      if (exists) {
        await db
          .update(shipmentPhotos)
          .set({ uploadedAt: new Date() })
          .where(eq(shipmentPhotos.id, p.id));
        stats.confirmed++;
      } else {
        await db.delete(shipmentPhotos).where(eq(shipmentPhotos.id, p.id));
        stats.deleted++;
      }
    } catch (err) {
      log.warn({ err, s3Key: p.s3Key }, 'shipment photo orphan cleanup: S3 HEAD failed');
      stats.errors++;
    }
  }

  if (stats.checked > 0) {
    log.info({ stats }, 'photo orphan cleanup completed');
  }
  return stats;
}
