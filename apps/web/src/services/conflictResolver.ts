import { db } from '../lib/db';
import type { Delivery } from '@matcheck/contracts';
import { runSync } from './sync';

export type ConflictStrategy = 'server_win' | 'local_win' | 'merge';

export async function listConflicts(): Promise<
  { mutationId: string; entityId: string; server: Delivery | null; local: Delivery | null }[]
> {
  const d = await db();
  const muts = await d.getAll('mutations');
  const conflicts = muts.filter((m) => m.conflictPending);
  const out: {
    mutationId: string;
    entityId: string;
    server: Delivery | null;
    local: Delivery | null;
  }[] = [];
  for (const m of conflicts) {
    const rec = await d.get('deliveries', m.entityId);
    const server = rec?.server ?? null;
    const local = rec ? ({ ...(rec.server ?? {}), ...(rec.local ?? {}) } as Delivery) : null;
    out.push({ mutationId: m.id, entityId: m.entityId, server, local });
  }
  return out;
}

export async function resolveConflict(
  mutationId: string,
  strategy: ConflictStrategy,
  merged?: Partial<Delivery>,
): Promise<void> {
  const d = await db();
  const m = await d.get('mutations', mutationId);
  if (!m) return;
  const rec = await d.get('deliveries', m.entityId);
  if (!rec) {
    await d.delete('mutations', mutationId);
    return;
  }

  if (strategy === 'server_win') {
    // Drop local overlay, keep server snapshot.
    await d.put('deliveries', { ...rec, local: null });
    await d.delete('mutations', mutationId);
  } else if (strategy === 'local_win') {
    // Replay with new baseVersion = server version
    await d.put('mutations', {
      ...m,
      conflictPending: false,
      attempts: 0,
      baseVersion: rec.server?.version ?? rec.version,
    });
    await d.put('deliveries', { ...rec, version: rec.server?.version ?? rec.version });
  } else {
    // Merge: write merged overlay, replay
    await d.put('deliveries', { ...rec, local: { ...(rec.local ?? {}), ...(merged ?? {}) } });
    await d.put('mutations', {
      ...m,
      conflictPending: false,
      attempts: 0,
      baseVersion: rec.server?.version ?? rec.version,
    });
  }
  await runSync();
}
