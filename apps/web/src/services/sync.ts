import type { SyncDeltaResponse } from '@matcheck/contracts';
import { api, ApiError, ConflictError } from './api';
import { db } from '../lib/db';
import { upsertServerSnapshot, buildUpsertPayload } from './deliveries';
import {
  upsertServerSnapshot as upsertShipmentSnapshot,
  buildUpsertPayload as buildShipmentUpsertPayload,
} from './shipments';
import { getSetting, setSetting } from '../lib/db';
import { useAuthStore } from '../stores/auth';
import { retryPendingUploads } from './photoPipeline';
import { runExclusive, tryRunExclusive } from './syncLock';

const CURSOR_KEY = 'sync_cursor';

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

export async function pushPendingMutations(): Promise<{ pushed: number; conflicts: number }> {
  const d = await db();
  const all = await d.getAll('mutations');
  const pending = all.filter((m) => !m.conflictPending);
  let pushed = 0;
  let conflicts = 0;
  for (const m of pending) {
    try {
      if (m.kind === 'delivery_upsert') {
        const rec = await d.get('deliveries', m.entityId);
        if (!rec) {
          await d.delete('mutations', m.id);
          continue;
        }
        const payload = buildUpsertPayload(rec);
        await api.post('/deliveries', payload);
        const fresh = await d.get('deliveries', m.entityId);
        if (fresh) await d.put('deliveries', { ...fresh, local: null });
        await d.delete('mutations', m.id);
        pushed += 1;
      } else if (m.kind === 'delivery_delete') {
        await api.delete(`/deliveries/${m.entityId}`);
        await d.delete('deliveries', m.entityId);
        await d.delete('mutations', m.id);
        pushed += 1;
      } else if (m.kind === 'shipment_upsert') {
        const rec = await d.get('shipments', m.entityId);
        if (!rec) {
          await d.delete('mutations', m.id);
          continue;
        }
        const payload = buildShipmentUpsertPayload(rec);
        await api.post('/shipments', payload);
        const fresh = await d.get('shipments', m.entityId);
        if (fresh) await d.put('shipments', { ...fresh, local: null });
        await d.delete('mutations', m.id);
        pushed += 1;
      } else if (m.kind === 'shipment_delete') {
        await api.delete(`/shipments/${m.entityId}`);
        await d.delete('shipments', m.entityId);
        await d.delete('mutations', m.id);
        pushed += 1;
      }
    } catch (err) {
      if (err instanceof ConflictError) {
        await d.put('mutations', { ...m, conflictPending: true });
        conflicts += 1;
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // 4xx — drop (broken local state, retrying won't help)
        await d.delete('mutations', m.id);
      } else {
        const next = { ...m, attempts: m.attempts + 1 };
        await d.put('mutations', next);
        // backoff: stop after attempts to avoid blocking queue
        if (next.attempts > 6) break;
      }
    }
  }
  return { pushed, conflicts };
}

/**
 * Тело синхронизации БЕЗ захвата лока. Вызывать только из контекста, который
 * лок уже держит (см. persistStatus в KppPage/ShipmentPage): Web Locks не
 * реентерабельны — повторный запрос того же лока изнутри даст дедлок.
 */
export async function runSyncUnlocked(): Promise<void> {
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
}

/**
 * Явный sync: ДОЖИДАЕТСЯ освобождения лока. Для действий пользователя, где
 * важно, чтобы мутация физически уехала (сохранение карточки, разрешение
 * конфликта, кнопка «Синхронизировать сейчас»).
 */
export async function runSync(): Promise<void> {
  if (!useAuthStore.getState().accessToken) return;
  await runExclusive(runSyncUnlocked);
}

/**
 * Фоновый sync: пропускается, если лок занят (прежнее поведение флага RUNNING).
 * Для интервала/online/visibility и fire-and-forget дозагрузки фото — иначе
 * ждущие вызовы выстроили бы очередь из нескольких полных проходов.
 */
export async function runSyncIfIdle(): Promise<void> {
  if (!useAuthStore.getState().accessToken) return;
  await tryRunExclusive(runSyncUnlocked);
}

let intervalHandle: number | null = null;

export function startSyncLoop(intervalMs = 60_000): () => void {
  if (intervalHandle) clearInterval(intervalHandle);
  void runSyncIfIdle();
  intervalHandle = window.setInterval(() => void runSyncIfIdle(), intervalMs);

  const onOnline = () => void runSyncIfIdle();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void runSyncIfIdle();
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
