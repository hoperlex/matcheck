/**
 * Очередь мутаций: отправка отложенных записей и ИСХОД конкретной мутации.
 *
 * Раньше всё это жило внутри `pushPendingMutations` в sync.ts и наружу отдавало
 * только счётчики `{ pushed, conflicts }` по всей очереди. Определить по ним
 * судьбу своей записи вызывающий не мог, а попытка вывести её из «мутации
 * больше нет в IndexedDB» неверна трижды:
 *
 *   1. `runSync()` мог вообще не начаться — синк уже шёл, и вызов возвращался
 *      сразу;
 *   2. сетевые и серверные ошибки гасились в `console.warn`;
 *   3. запись удаляется при ЛЮБОМ 4xx, а не только после успешной записи, —
 *      то есть отброшенный 400/403/422 выглядел точно так же, как успех.
 *
 * Из-за этого карточка приёмки показывала «Приёмка сохранена» на конфликте
 * версий: сервер честно отклонял правку, а человек уходил уверенным, что она
 * записана. Поэтому исход теперь называется явно.
 */

import { api, ApiError, ConflictError } from './api';
import { db, type MutationRecord } from '../lib/db';
import type { MatcheckDB } from '../lib/db';
import type { IDBPDatabase } from 'idb';
import { buildUpsertPayload } from './deliveries';
import { buildUpsertPayload as buildShipmentUpsertPayload } from './shipments';
import { useAuthStore } from '../stores/auth';

/**
 * `server_acked`    — сервер принял запись, мутация снята с очереди;
 * `conflict`        — 409: запись изменили на другом устройстве, отправка
 *                     заблокирована до разрешения конфликта;
 * `queued`          — не доехала (нет сети/5xx), лежит в очереди и будет
 *                     повторена;
 * `terminal_error`  — сервер отказал окончательно (4xx), повтор не поможет.
 */
export type MutationOutcome = 'server_acked' | 'conflict' | 'queued' | 'terminal_error';

export type MutationResult = { outcome: MutationOutcome; error?: Error };

/**
 * Последовательная очередь доступа к отправке. Два прохода не должны идти
 * одновременно: обе стороны читают и удаляют одни и те же записи, и мутация
 * ушла бы на сервер дважды.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Исходы недавно обработанных мутаций. Нужны, когда запись успел отправить
 * фоновый проход: спрашивающий приходит к пустой очереди и без этой памяти не
 * отличил бы успех от отказа.
 */
const OUTCOME_MEMORY = 50;
const lastOutcomes = new Map<string, MutationResult>();

function rememberOutcome(id: string, result: MutationResult): void {
  lastOutcomes.set(id, result);
  if (lastOutcomes.size > OUTCOME_MEMORY) {
    const oldest = lastOutcomes.keys().next();
    if (!oldest.done) lastOutcomes.delete(oldest.value);
  }
}

export async function getMutation(id: string): Promise<MutationRecord | undefined> {
  const d = await db();
  return d.get('mutations', id);
}

async function processMutation(
  d: IDBPDatabase<MatcheckDB>,
  m: MutationRecord,
): Promise<MutationResult> {
  try {
    if (m.kind === 'delivery_upsert' || m.kind === 'shipment_upsert') {
      const store = m.kind === 'delivery_upsert' ? 'deliveries' : 'shipments';
      const rec = await d.get(store, m.entityId);
      if (!rec) {
        // Записи, ради которой ставилась мутация, в хранилище нет — отправлять
        // нечего. Для вызывающего это отказ: молчаливым успехом такое считать
        // нельзя, иначе правка «сохранится» в никуда.
        await d.delete('mutations', m.id);
        return {
          outcome: 'terminal_error',
          error: new Error('Черновик не найден в локальном хранилище'),
        };
      }
      const payload =
        m.kind === 'delivery_upsert'
          ? buildUpsertPayload(rec as Parameters<typeof buildUpsertPayload>[0])
          : buildShipmentUpsertPayload(rec as Parameters<typeof buildShipmentUpsertPayload>[0]);
      await api.post(m.kind === 'delivery_upsert' ? '/deliveries' : '/shipments', payload);
      const fresh = await d.get(store, m.entityId);
      if (fresh) await d.put(store, { ...fresh, local: null });
      await d.delete('mutations', m.id);
      return { outcome: 'server_acked' };
    }

    if (m.kind === 'delivery_delete' || m.kind === 'shipment_delete') {
      const store = m.kind === 'delivery_delete' ? 'deliveries' : 'shipments';
      await api.delete(`/${store}/${m.entityId}`);
      await d.delete(store, m.entityId);
      await d.delete('mutations', m.id);
      return { outcome: 'server_acked' };
    }

    return { outcome: 'server_acked' };
  } catch (err) {
    if (err instanceof ConflictError) {
      await d.put('mutations', { ...m, conflictPending: true });
      return { outcome: 'conflict', error: err };
    }
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      // 4xx — повтор не поможет (сломанное локальное состояние либо отказ по
      // правам). Мутацию снимаем, но исход возвращаем как отказ.
      await d.delete('mutations', m.id);
      return { outcome: 'terminal_error', error: err };
    }
    const next = { ...m, attempts: m.attempts + 1 };
    await d.put('mutations', next);
    return { outcome: 'queued', error: err as Error };
  }
}

/** Максимум повторов, после которого проход прекращается, чтобы не молотить очередь. */
const MAX_ATTEMPTS = 6;

export async function pushPendingMutations(): Promise<{ pushed: number; conflicts: number }> {
  const d = await db();
  const all = await d.getAll('mutations');
  const pending = all.filter((m) => !m.conflictPending);
  let pushed = 0;
  let conflicts = 0;
  for (const m of pending) {
    const result = await processMutation(d, m);
    rememberOutcome(m.id, result);
    if (result.outcome === 'server_acked') pushed += 1;
    else if (result.outcome === 'conflict') conflicts += 1;
    else if (result.outcome === 'queued' && m.attempts + 1 > MAX_ATTEMPTS) break;
  }
  return { pushed, conflicts };
}

/**
 * Отправить КОНКРЕТНУЮ мутацию и вернуть её исход.
 *
 * Ждёт текущий проход очереди, а не пропускает отправку: без этого вызов,
 * совпавший с фоновым синком, возвращался бы мгновенно и ни о чём не говорил.
 */
export async function flushMutation(mutationId: string): Promise<MutationResult> {
  return withQueueLock(async () => {
    const d = await db();
    const m = await d.get('mutations', mutationId);
    if (!m) {
      // Очередь пуста: запись обработал предыдущий проход — берём его исход.
      // Если памяти о нём нет (другая вкладка, перезапуск), считаем принятой:
      // единственный путь удаления без запоминания — успешная отправка.
      return lastOutcomes.get(mutationId) ?? { outcome: 'server_acked' as const };
    }
    if (m.conflictPending) return { outcome: 'conflict' as const };
    if (!useAuthStore.getState().accessToken) return { outcome: 'queued' as const };
    const result = await processMutation(d, m);
    rememberOutcome(mutationId, result);
    return result;
  });
}
