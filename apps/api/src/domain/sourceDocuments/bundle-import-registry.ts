// Реестр входных файлов пачки (bundle_import_items): выборки, общие для воркера
// и HTTP-роутов.
//
// Живёт в domain, а не в worker.ts, потому что нужен обоим процессам, а
// worker.ts — исполняемый модуль: на верхнем уровне он создаёт Queue, двух
// BullMQ-воркеров, вешает обработчики сигналов и периодические задачи. Импорт
// его из роута поднял бы второго воркера прямо в API-процессе.

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { bundleImportItems, sourceBundles } from '../../db/schema.js';

export type RegistryRow = {
  id: string;
  bundleId: string;
  s3Key: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadGeneration: number | null;
  status: string;
  processingMode: string;
  detectedKind: string | null;
  confidence: string | null;
  parserUsed: string | null;
  createdDocumentIds: string[];
  reason: string | null;
  createdAt: Date;
};

const columns = {
  id: bundleImportItems.id,
  bundleId: bundleImportItems.bundleId,
  s3Key: bundleImportItems.inputS3Key,
  filename: bundleImportItems.sourceFilename,
  mimeType: bundleImportItems.mimeType,
  sizeBytes: bundleImportItems.sizeBytes,
  uploadGeneration: bundleImportItems.uploadGeneration,
  status: bundleImportItems.status,
  processingMode: bundleImportItems.processingMode,
  detectedKind: bundleImportItems.detectedKind,
  confidence: bundleImportItems.confidence,
  parserUsed: bundleImportItems.parserUsed,
  createdDocumentIds: bundleImportItems.createdDocumentIds,
  reason: bundleImportItems.reason,
  createdAt: bundleImportItems.createdAt,
};

/**
 * Строки реестра пакета, относящиеся к ЖИВОЙ загрузке.
 *
 * Правило одно и то же в разборе и в выдаче файлов на портал: если у пакета
 * есть строки активного поколения — берутся только они; иначе fallback на
 * строки без поколения (пакеты, принятые до того, как реестр стал заводиться
 * при приёме). Условие «поколение активное ИЛИ NULL» через OR не годится: оно
 * смешало бы legacy-строки с активной загрузкой и показало файлы брошенной
 * попытки.
 */
export async function selectRegistryRows(
  db: Db,
  bundleId: string,
  activeUploadGeneration: number,
): Promise<RegistryRow[]> {
  const active = await db
    .select(columns)
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.bundleId, bundleId),
        isNotNull(bundleImportItems.inputS3Key),
        eq(bundleImportItems.uploadGeneration, activeUploadGeneration),
      ),
    );
  if (active.length > 0) return active;

  return db
    .select(columns)
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.bundleId, bundleId),
        isNotNull(bundleImportItems.inputS3Key),
        isNull(bundleImportItems.uploadGeneration),
      ),
    );
}

/**
 * Корневой пакет поставки: накладные router разворачивает в ДОЧЕРНИЙ пакет, а
 * дополнительные файлы лежат на родителе. Паттерн тот же, что в public-origin.ts.
 */
export async function resolveRootBundle(
  db: Db,
  bundleId: string,
): Promise<{ id: string; activeUploadGeneration: number } | null> {
  const [row] = await db
    .select({
      id: sourceBundles.id,
      parentBundleId: sourceBundles.parentBundleId,
      activeUploadGeneration: sourceBundles.activeUploadGeneration,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, bundleId))
    .limit(1);
  if (!row) return null;
  if (!row.parentBundleId) {
    return { id: row.id, activeUploadGeneration: row.activeUploadGeneration };
  }

  const [parent] = await db
    .select({
      id: sourceBundles.id,
      activeUploadGeneration: sourceBundles.activeUploadGeneration,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, row.parentBundleId))
    .limit(1);
  return parent ?? { id: row.id, activeUploadGeneration: row.activeUploadGeneration };
}

/**
 * Дополнительные файлы поставки: всё, что сохранено без распознавания.
 *
 * Это и файлы из зоны «Дополнительные документы» (processing_mode='store_only'),
 * и файлы, тип которых определить не удалось — второе тоже нужно показать, иначе
 * оно исчезнет из виду. Признак один: терминальный `skipped` с живым ключом S3.
 */
export async function selectExtraFiles(db: Db, bundleId: string): Promise<RegistryRow[]> {
  const root = await resolveRootBundle(db, bundleId);
  if (!root) return [];
  const rows = await selectRegistryRows(db, root.id, root.activeUploadGeneration);
  return rows.filter((r) => r.status === 'skipped' && r.s3Key !== null);
}
