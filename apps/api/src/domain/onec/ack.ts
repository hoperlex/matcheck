/**
 * Подтверждения 1С. Подтверждение — заявление 1С о том, что у неё лежит: оно
 * принимается ВСЕГДА, без сверки с нашим состоянием. Сверку делает следующий
 * проход поиска изменений (detection.ts): если у 1С не то, что в портале,
 * приёмка вернётся в очередь. Поэтому гонки «приёмку изменили между выборкой и
 * подтверждением» не нужно закрывать блокировками — они сходятся сами.
 *
 * Таблица правил (decideAck) — docs/ONEC_API.md, раздел «Подтверждение».
 */
import { sql } from 'drizzle-orm';
import type { OnecAckItem, OnecAckResult } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import type { OnecQueueReason } from '../../db/schema.js';
import { SUPPORTED_HASH_VERSIONS } from './content-hash.js';

const HASH_RE = /^[0-9a-f]{64}$/;

export type AckRowState = {
  contentHash: string | null;
  queueReason: OnecQueueReason | null;
  pendingHash: string | null;
};

export type AckDecision =
  /** Новая версия у 1С: хеш, версия, новое окно поиска, причина снимается. */
  | { kind: 'store'; contentHash: string; hashVersion: number | null }
  /** Подтверждён найденный (откаченный) хеш: причина снимается, окно не сдвигается. */
  | { kind: 'confirm_pending' }
  /** Повтор: только журнал подтверждений. Окно и пометка не трогаются. */
  | { kind: 'repeat' }
  /** 1С сообщила об ошибке загрузки: только last_error. */
  | { kind: 'error'; message: string };

/** Чистое решение по одному подтверждению — вся таблица правил здесь. */
export function decideAck(row: AckRowState, input: OnecAckItem): AckDecision {
  if ('failed' in input) return { kind: 'error', message: input.failed.message };
  if ('deleted' in input) {
    return row.contentHash === 'deleted'
      ? { kind: 'repeat' }
      : { kind: 'store', contentHash: 'deleted', hashVersion: null };
  }
  const h = input.contentHash;
  if (row.contentHash === null || h !== row.contentHash) {
    return { kind: 'store', contentHash: h, hashVersion: input.hashVersion };
  }
  // h совпал с тем, что уже у 1С. Если проход нашёл, что текущее содержимое —
  // ровно h (правку откатили), это подтверждение найденного: пометку снять.
  // Иначе это повтор старого подтверждения, а изменение ещё не загружено.
  if (row.queueReason === 'changed' && row.pendingHash === h) return { kind: 'confirm_pending' };
  return { kind: 'repeat' };
}

function validate(input: OnecAckItem): OnecAckResult['result'] | null {
  if ('contentHash' in input) {
    if (!HASH_RE.test(input.contentHash)) return 'invalid_hash';
    if (!SUPPORTED_HASH_VERSIONS.includes(input.hashVersion)) return 'unsupported_hash_version';
  }
  return null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function applyOne(
  db: Db,
  input: OnecAckItem,
  serviceAccountId: string | null,
): Promise<OnecAckResult['result']> {
  const invalid = validate(input);
  if (invalid) return invalid;

  return db.transaction(async (tx: Tx) => {
    const [known] = [
      ...(await tx.execute(sql`
        select (select display_id::text from deliveries where id = ${input.id}::uuid) as display_id,
               exists (select 1 from deliveries where id = ${input.id}::uuid)
               or exists (select 1 from entity_deletions
                           where entity_type = 'delivery' and entity_id = ${input.id}::uuid)
               or exists (select 1 from delivery_onec_exports where delivery_id = ${input.id}::uuid)
               as known`)),
    ] as { display_id: string | null; known: boolean }[];
    if (!known?.known) return 'unknown_delivery';

    await tx.execute(sql`
      insert into delivery_onec_exports (delivery_id, display_id, service_account_id)
      values (${input.id}::uuid, ${known.display_id}::bigint, ${serviceAccountId}::uuid)
      on conflict (delivery_id) do nothing`);
    const [row] = [
      ...(await tx.execute(sql`
        select content_hash, queue_reason, pending_hash
          from delivery_onec_exports where delivery_id = ${input.id}::uuid
         for update`)),
    ] as { content_hash: string | null; queue_reason: OnecQueueReason | null; pending_hash: string | null }[];

    const decision = decideAck(
      { contentHash: row!.content_hash, queueReason: row!.queue_reason, pendingHash: row!.pending_hash },
      input,
    );
    switch (decision.kind) {
      case 'store':
        await tx.execute(sql`
          update delivery_onec_exports
             set content_hash = ${decision.contentHash}, hash_version = ${decision.hashVersion}::int,
                 exported_at = clock_timestamp(),
                 first_exported_at = coalesce(first_exported_at, clock_timestamp()),
                 last_ack_at = clock_timestamp(), ack_count = ack_count + 1,
                 queue_reason = null, queue_since = null, pending_hash = null,
                 last_error = null, last_error_at = null,
                 display_id = coalesce(${known.display_id}::bigint, display_id),
                 service_account_id = ${serviceAccountId}::uuid, updated_at = now()
           where delivery_id = ${input.id}::uuid`);
        break;
      case 'confirm_pending':
        await tx.execute(sql`
          update delivery_onec_exports
             set queue_reason = null, queue_since = null, pending_hash = null,
                 last_ack_at = clock_timestamp(), ack_count = ack_count + 1,
                 last_error = null, last_error_at = null,
                 service_account_id = ${serviceAccountId}::uuid, updated_at = now()
           where delivery_id = ${input.id}::uuid`);
        break;
      case 'repeat':
        await tx.execute(sql`
          update delivery_onec_exports
             set last_ack_at = clock_timestamp(), ack_count = ack_count + 1, updated_at = now()
           where delivery_id = ${input.id}::uuid`);
        break;
      case 'error':
        await tx.execute(sql`
          update delivery_onec_exports
             set last_error = ${decision.message}, last_error_at = clock_timestamp(),
                 service_account_id = ${serviceAccountId}::uuid, updated_at = now()
           where delivery_id = ${input.id}::uuid`);
        break;
    }
    return 'ok';
  });
}

/**
 * Каждое подтверждение — своей транзакцией: ошибка одного не откатывает
 * остальные, результат — по каждому элементу.
 */
export async function applyAcks(
  db: Db,
  items: readonly OnecAckItem[],
  serviceAccountId: string | null,
): Promise<OnecAckResult[]> {
  const results: OnecAckResult[] = [];
  for (const item of items) {
    results.push({ id: item.id, result: await applyOne(db, item, serviceAccountId) });
  }
  return results;
}
