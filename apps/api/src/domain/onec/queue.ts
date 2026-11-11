/**
 * Очередь выдачи в 1С: одна причина на приёмку, приоритет
 * deleted > restored > changed > new.
 *
 *  - new — успешного подтверждения ещё не было (строки выгрузки нет или
 *    content_hash IS NULL — её могла создать ошибка первой загрузки).
 *    Вычисляется запросом, не хранится. sortAt = confirmed_by_mol_at: первое
 *    подтверждение МОЛ побеждает через COALESCE (routes/deliveries.ts), время
 *    не плывёт.
 *  - changed / deleted / restored — сохранённая queue_reason; приоритет уже
 *    соблюдён при записи (detection.ts). sortAt = queue_since, меняется только
 *    со сменой причины.
 *
 * Обход — по ключу (sortAt, id) через непрозрачный курсор. В пределах одного
 * обхода при конкурентных изменениях возможны повтор и пропуск (сменилась
 * причина — сдвинулся sortAt); пропущенное попадёт в следующий цикл, который
 * начинается с начала.
 */
import { sql } from 'drizzle-orm';
import type { OnecQueueItem } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { isoUtc } from './export-loader.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QueueCursorError extends Error {}

export function encodeCursor(sortAt: string, id: string): string {
  return Buffer.from(JSON.stringify([sortAt, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new QueueCursorError('invalid_cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !ISO_RE.test(parsed[0]) ||
    !UUID_RE.test(parsed[1])
  ) {
    throw new QueueCursorError('invalid_cursor');
  }
  return { sortAt: parsed[0], id: parsed[1] };
}

/**
 * Дата начала очереди из env. Только дата (YYYY-MM-DD) — полночь по Москве:
 * подтверждения МОЛ считаются в рабочем дне объектов. null — значение не
 * задано или не разбирается (тогда очередь отвечает 503 not_configured, а не
 * выдаёт всю историю).
 */
export function parseExportSince(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return Number.isNaN(Date.parse(`${v}T00:00:00+03:00`)) ? null : `${v}T00:00:00+03:00`;
  }
  return ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

export type QueuePage = { items: OnecQueueItem[]; nextCursor: string | null; truncated: boolean };

export async function listQueue(
  db: Db,
  opts: { since: string; limit: number; cursor?: string; confirmedBefore?: string },
): Promise<QueuePage> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = [
    ...(await db.execute(sql`
      with q as (
        select d.id, d.display_id, 'new'::text as reason, d.confirmed_by_mol_at as sort_ts,
               null::text as exported_hash, null::text as detected_hash, e.last_error
          from deliveries d
          join statuses s on s.id = d.status_id and s.entity_type = 'delivery' and s.code = 'confirmed_mol'
          left join delivery_onec_exports e on e.delivery_id = d.id
         where d.pending_deletion_at is null
           and d.source_shipment_id is null
           and d.confirmed_by_mol_at >= ${opts.since}::timestamptz
           and (${opts.confirmedBefore ?? null}::timestamptz is null
                or d.confirmed_by_mol_at < ${opts.confirmedBefore ?? null}::timestamptz)
           and (e.delivery_id is null or e.content_hash is null)
        union all
        select e.delivery_id, e.display_id, e.queue_reason, e.queue_since,
               e.content_hash, e.pending_hash, e.last_error
          from delivery_onec_exports e
         where e.queue_reason is not null
      )
      select id::text as id, display_id::text as display_id, reason,
             ${isoUtc('sort_ts')} as sort_at, exported_hash, detected_hash, last_error
        from q
       where (${after?.sortAt ?? null}::timestamptz is null
              or (sort_ts, id) > (${after?.sortAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
       order by sort_ts, id
       limit ${opts.limit + 1}`)),
  ] as {
    id: string;
    display_id: string | null;
    reason: OnecQueueItem['reason'];
    sort_at: string;
    exported_hash: string | null;
    detected_hash: string | null;
    last_error: string | null;
  }[];

  const truncated = rows.length > opts.limit;
  const page = truncated ? rows.slice(0, opts.limit) : rows;
  const items: OnecQueueItem[] = page.map((r) => ({
    id: r.id,
    displayId: r.display_id === null ? null : Number(r.display_id),
    reason: r.reason,
    sortAt: r.sort_at,
    exportedHash: r.exported_hash,
    detectedHash: r.detected_hash,
    lastError: r.last_error,
  }));
  const last = items[items.length - 1];
  return {
    items,
    truncated,
    nextCursor: truncated && last ? encodeCursor(last.sortAt, last.id) : null,
  };
}
