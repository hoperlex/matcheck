/**
 * Проход поиска изменений для очереди 1С. Запускается первой страницей очереди
 * (запрос без cursor); следующие страницы читают сохранённое состояние.
 *
 * Почему пересчёт хеша, а не отметки времени: привязка и отвязка УПД из ЭДО не
 * двигают deliveries.updated_at/version, а удаление привязки вообще не
 * оставляет следа. Поэтому хеш выгруженных приёмок считается заново тем же
 * построителем, что отдаёт данные (export-read.ts).
 *
 * Фаза A — переходы статуса (дешёвый SQL по всем строкам), фаза B — хеши в
 * окне. Все записи условные: подтверждение 1С, пришедшее во время прохода, не
 * перетирается (условие по content_hash), а 'deleted' не понижается до
 * 'changed' (условие по queue_reason). Поэтому параллельные проходы безопасны.
 *
 * Окно: проверяются строки, чьё окно (exported_at + N дней) было открыто хоть в
 * один момент после начала ПРОШЛОГО прохода — простой 1С на границе окна не
 * теряет изменения. Найденное изменение (queue_reason='changed') проверяется
 * каждым проходом независимо от окна, пока 1С его не подтвердит.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { buildBodies } from './export-read.js';
import { isoUtc, readInSnapshot, type Executor } from './export-loader.js';

/** Порция пересчёта: ~10 запросов на порцию независимо от её размера. */
export const DETECTION_BATCH = 500;

export type DetectionResult = {
  startedAt: string;
  phaseA: { deleted: number; undeleted: number; restored: number; unrestored: number };
  checked: number;
  marked: number;
  ms: number;
};

type Count = { n: string };

async function count(ex: Executor, query: ReturnType<typeof sql>): Promise<number> {
  const rows = [...(await ex.execute(query))] as Count[];
  return Number(rows[0]?.n ?? 0);
}

/** Живая приёмка — есть и не в корзине. */
const ALIVE = sql.raw(
  `exists (select 1 from deliveries d where d.id = e.delivery_id and d.pending_deletion_at is null)`,
);

export async function runDetectionPass(
  db: Db,
  opts: { windowDays: number },
): Promise<DetectionResult> {
  const t = Date.now();
  const [start] = [
    ...(await db.execute(sql`select ${isoUtc('clock_timestamp()')} as t0`)),
  ] as { t0: string }[];
  const t0 = start!.t0;

  // ── Фаза A: переходы статуса, приоритет deleted > restored > changed ──
  const phaseA = await db.transaction(async (tx) => {
    const run = (q: ReturnType<typeof sql>) => count(tx, q);
    // A1: у 1С версия приёмки, а приёмки нет или она в корзине → deleted.
    // Пометка changed поглощается (приоритет удаления).
    const deleted = await run(sql`
      with u as (
        update delivery_onec_exports e
           set queue_reason = 'deleted', queue_since = clock_timestamp(),
               pending_hash = null, updated_at = now()
         where e.content_hash is not null and e.content_hash <> 'deleted'
           and e.queue_reason is distinct from 'deleted'
           and not ${ALIVE}
        returning 1)
      select count(*)::text as n from u`);
    // A2: восстановили до подтверждения удаления → принудительная перепроверка.
    // При совпадении хеша с тем, что у 1С, это одна лишняя пересылка.
    const undeleted = await run(sql`
      with u as (
        update delivery_onec_exports e
           set queue_reason = 'changed', queue_since = clock_timestamp(),
               pending_hash = null, updated_at = now()
         where e.queue_reason = 'deleted'
           and ${ALIVE}
        returning 1)
      select count(*)::text as n from u`);
    // A3: 1С применила удаление, а приёмка снова живая и подтверждённая → restored.
    const restored = await run(sql`
      with u as (
        update delivery_onec_exports e
           set queue_reason = 'restored', queue_since = clock_timestamp(),
               pending_hash = null, updated_at = now()
         where e.content_hash = 'deleted'
           and e.queue_reason is distinct from 'restored'
           and exists (
             select 1 from deliveries d
               join statuses s on s.id = d.status_id
              where d.id = e.delivery_id and d.pending_deletion_at is null
                and d.source_shipment_id is null
                and s.entity_type = 'delivery' and s.code = 'confirmed_mol')
        returning 1)
      select count(*)::text as n from u`);
    // A4: снова удалили до подтверждения restored → у 1С 'deleted', это и есть факт.
    const unrestored = await run(sql`
      with u as (
        update delivery_onec_exports e
           set queue_reason = null, queue_since = null, updated_at = now()
         where e.queue_reason = 'restored'
           and not ${ALIVE}
        returning 1)
      select count(*)::text as n from u`);
    return { deleted, undeleted, restored, unrestored };
  });

  // ── Фаза B: хеши в одном снимке ──
  const computed = await readInSnapshot(db, async (tx, snapshotAt) => {
    const [state] = [
      ...(await tx.execute(sql`
        select ${isoUtc('last_pass_started_at')} as last from onec_detection_state where id = 1`)),
    ] as { last: string | null }[];
    const lastPass = state?.last ?? null;
    const candidates = [
      ...(await tx.execute(sql`
        select e.delivery_id::text as id, e.content_hash as stored
          from delivery_onec_exports e
          join deliveries d on d.id = e.delivery_id and d.pending_deletion_at is null
         where e.content_hash is not null and e.content_hash <> 'deleted'
           and (e.queue_reason = 'changed'
                or (e.queue_reason is null
                    and (${lastPass}::timestamptz is null
                         or e.exported_at > ${lastPass}::timestamptz - make_interval(days => ${opts.windowDays}))))`)),
    ] as { id: string; stored: string }[];

    const result: { id: string; stored: string; current: string }[] = [];
    for (let i = 0; i < candidates.length; i += DETECTION_BATCH) {
      const part = candidates.slice(i, i + DETECTION_BATCH);
      const bodies = await buildBodies(
        tx,
        part.map((c) => c.id),
        snapshotAt,
      );
      for (const c of part) {
        const built = bodies.get(c.id);
        if (built) result.push({ id: c.id, stored: c.stored, current: built.hash });
      }
    }
    return result;
  });

  // ── Запись: условно по content_hash и причине ──
  // C ≠ сохранённого → changed (queue_since держится, пока причина та же);
  // C = сохранённому и уже changed (правку откатили) → только pending_hash = C:
  // пометку снимет подтверждение этого хеша, а не проход по устаревшему снимку.
  let marked = 0;
  if (computed.length > 0) {
    marked = await count(
      db,
      sql`
        with v as (
          select * from jsonb_to_recordset(${JSON.stringify(computed)}::jsonb)
            as v(id uuid, stored text, current text)),
        u as (
          update delivery_onec_exports e
             set queue_reason = 'changed',
                 queue_since = case when e.queue_reason = 'changed' then e.queue_since
                                    else clock_timestamp() end,
                 pending_hash = v.current,
                 updated_at = now()
            from v
           where e.delivery_id = v.id
             and e.content_hash = v.stored
             and (e.queue_reason is null or e.queue_reason = 'changed')
             and (v.current <> v.stored or e.queue_reason = 'changed')
             and (e.queue_reason is null or e.pending_hash is distinct from v.current)
          returning 1)
        select count(*)::text as n from u`,
    );
  }

  const ms = Date.now() - t;
  await db.execute(sql`
    insert into onec_detection_state (id, last_pass_started_at, last_pass_finished_at, last_pass_rows, last_pass_ms)
    values (1, ${t0}::timestamptz, clock_timestamp(), ${computed.length}, ${ms})
    on conflict (id) do update
       set last_pass_started_at = greatest(onec_detection_state.last_pass_started_at, excluded.last_pass_started_at),
           last_pass_finished_at = excluded.last_pass_finished_at,
           last_pass_rows = excluded.last_pass_rows,
           last_pass_ms = excluded.last_pass_ms`);

  return { startedAt: t0, phaseA, checked: computed.length, marked, ms };
}
