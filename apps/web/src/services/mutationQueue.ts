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
import { withDb, type MutationRecord } from '../lib/db';
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
  return withDb((dbi) => dbi.get('mutations', id));
}

/**
 * Исход неудачной ОТПРАВКИ. Вынесен из `processMutation`, чтобы разбор ошибки
 * не накрывал работу с базой: см. комментарий к фазам ниже.
 */
async function recordSendFailure(m: MutationRecord, err: unknown): Promise<MutationResult> {
  if (err instanceof ConflictError) {
    await withDb((dbi) => dbi.put('mutations', { ...m, conflictPending: true }));
    return { outcome: 'conflict', error: err };
  }
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    // 4xx — повтор не поможет (сломанное локальное состояние либо отказ по
    // правам). Мутацию снимаем, но исход возвращаем как отказ.
    await withDb((dbi) => dbi.delete('mutations', m.id));
    return { outcome: 'terminal_error', error: err };
  }
  await withDb((dbi) => dbi.put('mutations', { ...m, attempts: m.attempts + 1 }));
  return { outcome: 'queued', error: err as Error };
}

/**
 * Отправка одной мутации в ТРИ фазы: чтение из базы → один сетевой вызов →
 * фиксация результата.
 *
 * Фазы разделены, потому что `withDb` повторяет свой колбэк на новом
 * соединении, если браузер закрыл старое под нами. Сетевой вызов внутри такого
 * колбэка ушёл бы на сервер дважды — поэтому в базу и в сеть ходим порознь.
 *
 * По той же причине `try/catch` накрывает ТОЛЬКО запрос. Пока он охватывал всю
 * функцию, падение финальной записи (уже ПОСЛЕ успешного ответа сервера)
 * разбиралось как сетевой сбой: мутация возвращалась в `queued` с ростом
 * attempts и уходила на сервер второй раз, хотя тот её принял.
 */
async function processMutation(m: MutationRecord): Promise<MutationResult> {
  const isUpsert = m.kind === 'delivery_upsert' || m.kind === 'shipment_upsert';
  const isDelete = m.kind === 'delivery_delete' || m.kind === 'shipment_delete';
  if (!isUpsert && !isDelete) return { outcome: 'server_acked' };

  const store =
    m.kind === 'delivery_upsert' || m.kind === 'delivery_delete' ? 'deliveries' : 'shipments';

  // ── Фаза 1. Читаем то, что предстоит отправить.
  let payload: unknown = null;
  if (isUpsert) {
    const rec = await withDb((dbi) => dbi.get(store, m.entityId));
    if (!rec) {
      // Записи, ради которой ставилась мутация, в хранилище нет — отправлять
      // нечего. Для вызывающего это отказ: молчаливым успехом такое считать
      // нельзя, иначе правка «сохранится» в никуда.
      await withDb((dbi) => dbi.delete('mutations', m.id));
      return {
        outcome: 'terminal_error',
        error: new Error('Черновик не найден в локальном хранилище'),
      };
    }
    payload =
      m.kind === 'delivery_upsert'
        ? buildUpsertPayload(rec as Parameters<typeof buildUpsertPayload>[0])
        : buildShipmentUpsertPayload(rec as Parameters<typeof buildShipmentUpsertPayload>[0]);
  }

  // ── Фаза 2. Ровно один сетевой вызов, и под catch — только он.
  try {
    if (isUpsert) await api.post(`/${store}`, payload);
    else await api.delete(`/${store}/${m.entityId}`);
  } catch (err) {
    return await recordSendFailure(m, err);
  }

  // ── Фаза 3. Сервер принял — фиксируем это локально одной транзакцией на оба
  // хранилища: снятие мутации и правка записи не должны расходиться. Порядок
  // внутри неважен, транзакция атомарна.
  try {
    await withDb(async (dbi) => {
      const tx = dbi.transaction([store, 'mutations'], 'readwrite');
      if (isUpsert) {
        const fresh = await tx.objectStore(store).get(m.entityId);
        if (fresh) await tx.objectStore(store).put({ ...fresh, local: null });
      } else {
        await tx.objectStore(store).delete(m.entityId);
      }
      await tx.objectStore('mutations').delete(m.id);
      await tx.done;
    });
  } catch (err) {
    // Сервер запись ПРИНЯЛ — значит исход именно `server_acked`, и человеку
    // нельзя показывать «не сохранилось». Не трогаем attempts и не переводим в
    // `queued`: локальная неудача не повод повторять отправку. Мутация может
    // остаться в очереди и уйти повторно — upsert на сервере идемпотентен по id.
    return { outcome: 'server_acked', error: err as Error };
  }

  return { outcome: 'server_acked' };
}

/** Максимум повторов, после которого проход прекращается, чтобы не молотить очередь. */
const MAX_ATTEMPTS = 6;

export async function pushPendingMutations(): Promise<{ pushed: number; conflicts: number }> {
  const all = await withDb((dbi) => dbi.getAll('mutations'));
  const pending = all.filter((m) => !m.conflictPending);
  let pushed = 0;
  let conflicts = 0;
  for (const m of pending) {
    const result = await processMutation(m);
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
    const m = await withDb((dbi) => dbi.get('mutations', mutationId));
    if (!m) {
      // Очередь пуста: запись обработал предыдущий проход — берём его исход.
      // Если памяти о нём нет (другая вкладка, перезапуск), считаем принятой:
      // единственный путь удаления без запоминания — успешная отправка.
      return lastOutcomes.get(mutationId) ?? { outcome: 'server_acked' as const };
    }
    if (m.conflictPending) return { outcome: 'conflict' as const };
    if (!useAuthStore.getState().accessToken) return { outcome: 'queued' as const };
    const result = await processMutation(m);
    rememberOutcome(mutationId, result);
    return result;
  });
}
