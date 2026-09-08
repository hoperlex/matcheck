import type { SyncDeltaResponse, UserDto } from '@matcheck/contracts';
import { api, ApiError } from './api';
import { db } from '../lib/db';
import { upsertServerSnapshot } from './deliveries';
import { upsertServerSnapshot as upsertShipmentSnapshot } from './shipments';
import { pushPendingMutations, withQueueLock } from './mutationQueue';
import { getSetting, setSetting } from '../lib/db';
import { useAuthStore } from '../stores/auth';
import { retryPendingUploads } from './photoPipeline';

const CURSOR_KEY = 'sync_cursor';

/**
 * Роли, которым сервер отдаёт GET /api/v1/sync. Зеркалит allow-list на роуте
 * (`app.authorize('admin', 'manager', 'inspector_kpp')` в
 * apps/api/src/routes/sync.ts) — contractor и monitor получают там 403.
 *
 * Гонять цикл для запрещённой роли бессмысленно вдвойне: каждый тик тратит
 * аутентификацию и оставляет запись в unauthorized_access_log, а данных всё
 * равно не приносит.
 */
const SYNC_ROLES: readonly UserDto['role'][] = ['admin', 'manager', 'inspector_kpp'];

/** Есть ли у роли доступ к офлайн-синхронизации. */
export function syncAvailableForRole(role: UserDto['role'] | undefined): boolean {
  return role !== undefined && SYNC_ROLES.includes(role);
}

export async function pullSync(): Promise<void> {
  const cursor = await getSetting<string>(CURSOR_KEY);
  const qs = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
  const res = await api.get<SyncDeltaResponse>(`/sync${qs}`);
  await upsertServerSnapshot(res.deliveries);
  await upsertShipmentSnapshot(res.shipments);

  const d = await db();
  const tx = d.transaction(['source_documents', 'references'], 'readwrite');
  for (const sd of res.sourceDocuments) {
    await tx.objectStore('source_documents').put(sd);
  }
  for (const cp of res.counterparties) {
    await tx.objectStore('references').put({ ...cp, kind: 'counterparty' });
  }
  for (const m of res.materials) {
    await tx.objectStore('references').put({ ...m, kind: 'material' });
  }
  for (const s of res.sites) {
    await tx.objectStore('references').put({ ...s, kind: 'site' });
  }
  await tx.done;
  await setSetting(CURSOR_KEY, res.serverNow);
}

/**
 * Идущий проход. Параллельный вызов ПРИСОЕДИНЯЕТСЯ к нему и дожидается конца:
 * прежний вариант возвращался мгновенно, и вызывающий не мог отличить «синк
 * отработал» от «синк даже не начинался». Отправку конкретной мутации ждёт
 * flushMutation (services/mutationQueue.ts).
 */
let running: Promise<void> | null = null;

export function runSync(): Promise<void> {
  if (running) return running;
  const started = withQueueLock(async () => {
    if (!useAuthStore.getState().accessToken) return;
    try {
      await pushPendingMutations();
      await pullSync();
      // После push+pull часть фото может быть готова к загрузке
      // (delivery теперь существует на сервере — /photos/presign не даст 404).
      await retryPendingUploads();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // session expired — store уже помечен expireSession(); ProtectedRoute
        // редиректит, повторять sync смысла нет
        return;
      }
      console.warn('sync failed', err);
    }
  }).finally(() => {
    running = null;
  });
  running = started;
  return started;
}

let intervalHandle: number | null = null;

export function startSyncLoop(intervalMs = 60_000): () => void {
  if (intervalHandle) clearInterval(intervalHandle);
  void runSync();
  intervalHandle = window.setInterval(() => {
    // Периодический тик — только для видимой вкладки. GET /api/v1/sync стоит
    // ~20 последовательных SELECT'ов, и забытая открытая вкладка гоняла их
    // каждую минуту весь рабочий день, ничего не показывая пользователю.
    // Возврат к вкладке закрывает onVisibility ниже: данные освежаются сразу,
    // как на вкладку посмотрят, поэтому пропуск тиков не «отстаёт» видимо.
    if (document.visibilityState !== 'visible') return;
    void runSync();
  }, intervalMs);

  const onOnline = () => void runSync();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void runSync();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = null;
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
