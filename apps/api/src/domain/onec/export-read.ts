/**
 * Полные данные приёмок для 1С: построитель + хеш + состояние выгрузки.
 *
 * Одна точка сборки и для ответа, и для поиска изменений (detection.ts): хеш,
 * который видит проход очереди, и contentHash в ответе обязаны совпадать для
 * одного и того же состояния — иначе подтверждение никогда не снимало бы
 * пометку.
 */
import { sql } from 'drizzle-orm';
import type { OnecDelivery, OnecExportState } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import type { OnecQueueReason } from '../../db/schema.js';
import { computeContentHash, HASH_VERSION } from './content-hash.js';
import { buildDeliveryBody, type OnecDeliveryBody } from './export-payload.js';
import {
  isoUtc,
  loadDeliveryBundles,
  readInSnapshot,
  uuidList,
  type Executor,
} from './export-loader.js';

export type ExportRow = {
  deliveryId: string;
  contentHash: string | null;
  hashVersion: number | null;
  exportedAt: string | null;
  queueReason: OnecQueueReason | null;
  pendingHash: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export async function loadExportRows(
  ex: Executor,
  deliveryIds: readonly string[],
): Promise<Map<string, ExportRow>> {
  if (deliveryIds.length === 0) return new Map();
  const rows = [
    ...(await ex.execute(sql`
      select delivery_id::text as delivery_id, content_hash, hash_version,
             ${isoUtc('exported_at')} as exported_at, queue_reason, pending_hash,
             last_error, ${isoUtc('last_error_at')} as last_error_at
        from delivery_onec_exports
       where delivery_id = any(${uuidList(deliveryIds)})`)),
  ] as {
    delivery_id: string;
    content_hash: string | null;
    hash_version: number | null;
    exported_at: string | null;
    queue_reason: OnecQueueReason | null;
    pending_hash: string | null;
    last_error: string | null;
    last_error_at: string | null;
  }[];
  return new Map(
    rows.map((r) => [
      r.delivery_id,
      {
        deliveryId: r.delivery_id,
        contentHash: r.content_hash,
        hashVersion: r.hash_version,
        exportedAt: r.exported_at,
        queueReason: r.queue_reason,
        pendingHash: r.pending_hash,
        lastError: r.last_error,
        lastErrorAt: r.last_error_at,
      },
    ]),
  );
}

export function exportStateOf(row: ExportRow | undefined, currentHash: string): OnecExportState {
  const base = {
    exportedAt: row?.exportedAt ?? null,
    exportedHash: row?.contentHash ?? null,
    queueReason: row?.queueReason ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
  };
  if (!row || row.contentHash === null) return { state: 'not_exported', ...base };
  if (row.contentHash === 'deleted') return { state: 'deleted', ...base };
  const same = row.hashVersion === HASH_VERSION && row.contentHash === currentHash;
  return { state: same ? 'exported' : 'changed', ...base };
}

/** Тела и хеши приёмок в уже открытом снимке. Нет приёмки — нет записи. */
export async function buildBodies(
  ex: Executor,
  deliveryIds: readonly string[],
  snapshotAt: string,
): Promise<Map<string, { body: OnecDeliveryBody; hash: string }>> {
  const bundles = await loadDeliveryBundles(ex, deliveryIds);
  const out = new Map<string, { body: OnecDeliveryBody; hash: string }>();
  for (const [id, bundle] of bundles) {
    const body = buildDeliveryBody(bundle, snapshotAt);
    out.set(id, { body, hash: computeContentHash(body) });
  }
  return out;
}

export type DeliveriesReadResult = {
  snapshotAt: string;
  items: OnecDelivery[];
  missing: { id: string; state: 'deleted' | 'not_found' }[];
};

/** Приёмки по id в одном снимке; порядок ответа — порядок запроса. */
export async function readDeliveries(db: Db, deliveryIds: readonly string[]): Promise<DeliveriesReadResult> {
  const unique = [...new Set(deliveryIds)];
  return readInSnapshot(db, async (tx, snapshotAt) => {
    const bodies = await buildBodies(tx, unique, snapshotAt);
    const exportRows = await loadExportRows(tx, unique);
    const absent = unique.filter((id) => !bodies.has(id));
    const deleted = new Set<string>();
    if (absent.length > 0) {
      const rows = [
        ...(await tx.execute(sql`
          select distinct entity_id::text as id
            from entity_deletions
           where entity_type = 'delivery' and entity_id = any(${uuidList(absent)})`)),
      ] as { id: string }[];
      for (const r of rows) deleted.add(r.id);
    }
    const items: OnecDelivery[] = [];
    for (const id of unique) {
      const built = bodies.get(id);
      if (!built) continue;
      items.push({
        ...built.body,
        contentHash: built.hash,
        hashVersion: HASH_VERSION,
        export: exportStateOf(exportRows.get(id), built.hash),
      });
    }
    return {
      snapshotAt,
      items,
      missing: absent.map((id) => ({ id, state: deleted.has(id) ? 'deleted' : 'not_found' })),
    };
  });
}

/** id приёмки по номеру; null — такой нет. */
export async function deliveryIdByDisplayId(ex: Executor, displayId: number): Promise<string | null> {
  const rows = [
    ...(await ex.execute(sql`select id::text as id from deliveries where display_id = ${displayId} limit 1`)),
  ] as { id: string }[];
  return rows[0]?.id ?? null;
}
