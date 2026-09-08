import { withDb } from '../lib/db';
import type { Delivery } from '@matcheck/contracts';
import { runSync } from './sync';

export type ConflictStrategy = 'server_win' | 'local_win' | 'merge';

export async function listConflicts(): Promise<
  { mutationId: string; entityId: string; server: Delivery | null; local: Delivery | null }[]
> {
  return withDb(async (dbi) => {
    const muts = await dbi.getAll('mutations');
    const conflicts = muts.filter((m) => m.conflictPending);
    const out: {
      mutationId: string;
      entityId: string;
      server: Delivery | null;
      local: Delivery | null;
    }[] = [];
    for (const m of conflicts) {
      const rec = await dbi.get('deliveries', m.entityId);
      const server = rec?.server ?? null;
      const local = rec ? ({ ...(rec.server ?? {}), ...(rec.local ?? {}) } as Delivery) : null;
      out.push({ mutationId: m.id, entityId: m.entityId, server, local });
    }
    return out;
  });
}

export async function resolveConflict(
  mutationId: string,
  strategy: ConflictStrategy,
  merged?: Partial<Delivery>,
): Promise<void> {
  // Разрешение конфликта — одной транзакцией на оба хранилища: половинчатое
  // состояние (мутация переиграна, запись не обновлена) отправило бы на сервер
  // не то, что показано человеку. Сеть — за пределами `withDb`: его колбэк
  // выполняется повторно, если браузер закрыл соединение.
  const resolved = await withDb(async (dbi) => {
    const tx = dbi.transaction(['deliveries', 'mutations'], 'readwrite');
    const mutations = tx.objectStore('mutations');
    const deliveries = tx.objectStore('deliveries');
    const m = await mutations.get(mutationId);
    if (!m) {
      await tx.done;
      return false;
    }
    const rec = await deliveries.get(m.entityId);
    if (!rec) {
      await mutations.delete(mutationId);
      await tx.done;
      return false;
    }

    if (strategy === 'server_win') {
      // Drop local overlay, keep server snapshot.
      await deliveries.put({ ...rec, local: null });
      await mutations.delete(mutationId);
    } else if (strategy === 'local_win') {
      // Replay with new baseVersion = server version
      await mutations.put({
        ...m,
        conflictPending: false,
        attempts: 0,
        baseVersion: rec.server?.version ?? rec.version,
      });
      await deliveries.put({ ...rec, version: rec.server?.version ?? rec.version });
    } else {
      // Merge: write merged overlay, replay
      await deliveries.put({ ...rec, local: { ...(rec.local ?? {}), ...(merged ?? {}) } });
      await mutations.put({
        ...m,
        conflictPending: false,
        attempts: 0,
        baseVersion: rec.server?.version ?? rec.version,
      });
    }
    await tx.done;
    return true;
  });
  if (!resolved) return;
  await runSync();
}
