// Откат импорта справочников по снимку (ImportSnapshot из apply.ts).
//
// Возвращаем только то, что с момента импорта никто не менял: поле строки
// восстанавливается, если сейчас в нём ровно то, что записал импорт. Склеенные
// дубли вставляются обратно с прежними id, их документы перепривязываются
// назад, если всё ещё указывают на цель. Вставленные строки удаляются, только
// если на них нет ссылок: удаление строки со ссылкой обнулило бы связь
// (ON DELETE SET NULL) — такие строки остаются и перечисляются.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customerCounterparties, sourceDocuments, suppliers, users } from '../../db/schema.js';
import { touchSourceDocuments } from '../sourceDocuments/touch.js';
import { SYNC_WINDOW_DAYS, type ImportSnapshot } from './apply.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export type RevertPlan = {
  supplierRestores: Array<{ id: string; set: Record<string, unknown> }>;
  supplierConflicts: Array<{ id: string; field: string; reason: string }>;
  reinserts: string[];
  repoints: Array<{ sourceId: string; targetId: string; docIds: string[] }>;
  supplierDeletes: string[];
  supplierKept: Array<{ id: string; reason: string }>;
  contractorRestores: Array<{ id: string; aliases: string[] }>;
  contractorConflicts: Array<{ id: string; reason: string }>;
  contractorDeletes: string[];
  contractorKept: Array<{ id: string; reason: string }>;
};

export type RevertResult = { applied: boolean; plan: RevertPlan; touchedDocIds: string[] };

const SUPPLIER_FIELDS = new Set([
  'billhubId',
  'inn',
  'name',
  'aliases',
  'lastSecurityStatus',
  'foundingDocumentsComment',
]);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function buildRevertPlan(ex: Executor, snap: ImportSnapshot): Promise<RevertPlan> {
  const plan: RevertPlan = {
    supplierRestores: [],
    supplierConflicts: [],
    reinserts: [],
    repoints: [],
    supplierDeletes: [],
    supplierKept: [],
    contractorRestores: [],
    contractorConflicts: [],
    contractorDeletes: [],
    contractorKept: [],
  };

  const supplierIds = [
    ...snap.supplierUpdates.map((u) => u.id),
    ...snap.supplierInserts,
    ...snap.merges.flatMap((m) => [m.targetId, ...m.sources.map((s) => s.row.id)]),
  ];
  const current = new Map(
    supplierIds.length > 0
      ? (
          await ex
            .select()
            .from(suppliers)
            .where(inArray(suppliers.id, [...new Set(supplierIds)]))
        ).map((r) => [r.id, r])
      : [],
  );

  for (const u of snap.supplierUpdates) {
    const row = current.get(u.id);
    if (!row) {
      plan.supplierConflicts.push({ id: u.id, field: '*', reason: 'строки больше нет' });
      continue;
    }
    const set: Record<string, unknown> = {};
    for (const [field, after] of Object.entries(u.after)) {
      if (!SUPPLIER_FIELDS.has(field)) continue;
      if (same(row[field as keyof typeof row], after)) set[field] = u.before[field] ?? null;
      else plan.supplierConflicts.push({ id: u.id, field, reason: 'поле изменили после импорта' });
    }
    if (Object.keys(set).length > 0) plan.supplierRestores.push({ id: u.id, set });
  }

  // Документы, которые вернутся к восстановленным дублям, не считаются
  // ссылками на вставленные строки.
  const leaving = new Set<string>();
  for (const m of snap.merges) {
    for (const s of m.sources) {
      if (current.has(s.row.id)) {
        plan.supplierKept.push({
          id: s.row.id,
          reason: 'дубль уже существует — не вставляем повторно',
        });
        continue;
      }
      plan.reinserts.push(s.row.id);
      const docIds =
        s.docIds.length > 0
          ? (
              await ex
                .select({ id: sourceDocuments.id })
                .from(sourceDocuments)
                .where(
                  and(
                    inArray(sourceDocuments.id, s.docIds),
                    eq(sourceDocuments.supplierDirectoryId, m.targetId),
                  ),
                )
            ).map((r) => r.id)
          : [];
      docIds.forEach((id) => leaving.add(id));
      plan.repoints.push({ sourceId: s.row.id, targetId: m.targetId, docIds });
    }
  }

  for (const id of snap.supplierInserts) {
    if (!current.has(id)) continue;
    const refs = await ex
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.supplierDirectoryId, id));
    const staying = refs.filter((r) => !leaving.has(r.id)).length;
    if (staying > 0)
      plan.supplierKept.push({ id, reason: `на строку ссылаются документы: ${staying}` });
    else plan.supplierDeletes.push(id);
  }

  const ccIds = [...snap.contractorUpdates.map((u) => u.id), ...snap.contractorInserts];
  const cc = new Map(
    ccIds.length > 0
      ? (
          await ex
            .select()
            .from(customerCounterparties)
            .where(inArray(customerCounterparties.id, ccIds))
        ).map((r) => [r.id, r])
      : [],
  );
  for (const u of snap.contractorUpdates) {
    const row = cc.get(u.id);
    if (!row) plan.contractorConflicts.push({ id: u.id, reason: 'строки больше нет' });
    else if (!same(row.aliases, u.after))
      plan.contractorConflicts.push({ id: u.id, reason: 'алиасы изменили после импорта' });
    else plan.contractorRestores.push({ id: u.id, aliases: u.before });
  }
  for (const id of snap.contractorInserts) {
    if (!cc.has(id)) continue;
    const refs = await ex
      .select({ id: users.id })
      .from(users)
      .where(eq(users.contractorCustomerId, id));
    if (refs.length > 0)
      plan.contractorKept.push({
        id,
        reason: `к подрядчику привязаны пользователи: ${refs.length}`,
      });
    else plan.contractorDeletes.push(id);
  }
  return plan;
}

export async function revertDirectoriesImport(
  db: Db,
  snap: ImportSnapshot,
  opts: { apply: boolean; lockTimeoutMs?: number },
): Promise<RevertResult> {
  if (snap.version !== 1) throw new Error(`неизвестная версия снимка: ${String(snap.version)}`);
  if (!opts.apply) {
    return db.transaction(
      async (tx) => ({ applied: false, plan: await buildRevertPlan(tx, snap), touchedDocIds: [] }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  const lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${Math.trunc(lockTimeoutMs)}ms'`));
    await tx.execute(sql.raw(`set local statement_timeout = '60s'`));
    await tx.execute(
      sql`lock table suppliers, customer_counterparties in share row exclusive mode`,
    );
    const plan = await buildRevertPlan(tx, snap);
    const now = new Date();

    const rows = new Map(
      snap.merges.flatMap((m) => m.sources.map((s) => [s.row.id, s.row] as const)),
    );
    for (const id of plan.reinserts) {
      const r = rows.get(id)!;
      await tx.insert(suppliers).values({
        id: r.id,
        billhubId: r.billhubId,
        inn: r.inn,
        name: r.name,
        aliases: r.aliases,
        lastSecurityStatus: r.lastSecurityStatus,
        foundingDocumentsComment: r.foundingDocumentsComment,
        createdAt: new Date(r.createdAt),
        updatedAt: now,
      });
    }
    for (const rp of plan.repoints) {
      if (rp.docIds.length === 0) continue;
      await tx
        .update(sourceDocuments)
        .set({ supplierDirectoryId: rp.sourceId })
        .where(
          and(
            inArray(sourceDocuments.id, rp.docIds),
            eq(sourceDocuments.supplierDirectoryId, rp.targetId),
          ),
        );
    }
    for (const r of plan.supplierRestores) {
      await tx
        .update(suppliers)
        .set({ ...r.set, updatedAt: now })
        .where(eq(suppliers.id, r.id));
    }
    if (plan.supplierDeletes.length > 0) {
      await tx.delete(suppliers).where(inArray(suppliers.id, plan.supplierDeletes));
    }
    for (const r of plan.contractorRestores) {
      await tx
        .update(customerCounterparties)
        .set({ aliases: r.aliases, updatedAt: now })
        .where(eq(customerCounterparties.id, r.id));
    }
    if (plan.contractorDeletes.length > 0) {
      await tx
        .delete(customerCounterparties)
        .where(inArray(customerCounterparties.id, plan.contractorDeletes));
    }

    // Имя поставщика у документов снова меняется — тот же сигнал планшету.
    const renamed = plan.supplierRestores.filter((r) => 'name' in r.set).map((r) => r.id);
    const touched = new Set(plan.repoints.flatMap((rp) => rp.docIds));
    if (renamed.length > 0) {
      const docs = await tx
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(inArray(sourceDocuments.supplierDirectoryId, renamed));
      docs.forEach((d) => touched.add(d.id));
    }
    const recent =
      touched.size > 0
        ? (
            await tx
              .select({ id: sourceDocuments.id })
              .from(sourceDocuments)
              .where(
                and(
                  inArray(sourceDocuments.id, [...touched]),
                  sql`${sourceDocuments.updatedAt} >= now() - make_interval(days => ${SYNC_WINDOW_DAYS})`,
                ),
              )
          ).map((d) => d.id)
        : [];
    await touchSourceDocuments({ db: tx }, recent);
    return { applied: true, plan, touchedDocIds: recent };
  });
}
