// Запись импорта справочников (scripts/import-directories.ts).
//
// dry-run — только чтение, одной read-only транзакцией: можно запускать под
// read-only ролью. apply — одна транзакция под блокировками:
//   1. lock_timeout/statement_timeout (на бою lock_timeout=0 — ждали бы вечно);
//   2. try-lock на импорт целиком — второй параллельный запуск выходит;
//   3. advisory-ключи матчера (supplierCreateLockKey) по каждой строке
//      BillHub — дожидаемся воркера, который уже прошёл перепроверку и стоит
//      на INSERT;
//   4. LOCK TABLE suppliers, customer_counterparties SHARE ROW EXCLUSIVE —
//      чтение и FK-проверки идут, чужие INSERT/UPDATE ждут ~секунды;
//   5. состояние → план → сверка отпечатка с подтверждённым dry-run;
//   6. FOR UPDATE источников склейки: ждём FK-операции (KEY SHARE), которые
//      уже ссылаются на них; новые не начнутся до COMMIT. Только после этого
//      собираем документы и пишем снимок — иначе документ, привязанный в этот
//      момент, перепривязался бы, но в снимок для отката не попал;
//   7. запись, проверка итоговых строк контрактом карточки, повторный план —
//      он обязан быть пустым, иначе ROLLBACK.
// Транзакция в READ COMMITTED (по умолчанию): запрос после FOR UPDATE видит
// всё, что закоммитили дождавшиеся транзакции.

import { randomUUID } from 'node:crypto';
import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { CustomerCounterpartyUpsertSchema, SupplierUpsertSchema } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { customerCounterparties, sourceDocuments, suppliers } from '../../db/schema.js';
import { supplierCreateLockKey } from '../sourceDocuments/supplierMatcher.js';
import { touchSourceDocuments } from '../sourceDocuments/touch.js';
import { innDigits } from './names.js';
import type { BillhubSupplier } from './parse.js';
import {
  buildDirectoriesPlan,
  FINGERPRINT_SHOWN,
  type DirectoriesInput,
  type DirectoriesPlan,
  type DirectoriesState,
} from './plan.js';
import type { SupplierPatch, SupplierRow } from './plan-suppliers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export const IMPORT_LOCK_KEY = 'matcheck:directories-import';
/** Окно начальной синхронизации планшета (routes/sync.ts, windowDays по умолчанию). */
export const SYNC_WINDOW_DAYS = 90;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export type ImportErrorCode =
  | 'busy'
  | 'fingerprint'
  | 'no_billhub_column'
  | 'write_mismatch'
  | 'invalid_row'
  | 'plan_not_empty'
  | 'bad_option';

export class DirectoriesImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DirectoriesImportError';
  }
}

export type SupplierRowJson = Omit<SupplierRow, 'createdAt'> & { createdAt: string };

/** Всё, что нужно для отката. Пишется до первой записи в базу. */
export type ImportSnapshot = {
  version: 1;
  importedAt: string;
  fingerprint: string;
  supplierUpdates: Array<{ id: string; before: Record<string, unknown>; after: SupplierPatch }>;
  supplierInserts: string[];
  merges: Array<{ targetId: string; sources: Array<{ row: SupplierRowJson; docIds: string[] }> }>;
  contractorUpdates: Array<{ id: string; before: string[]; after: string[] }>;
  contractorInserts: string[];
  touchedDocIds: string[];
};

export type DocsToTouch = {
  /** Источник склейки → id его документов. */
  bySource: Map<string, string[]>;
  /** Документы в окне синхронизации, у которых сменится имя поставщика. */
  touchIds: string[];
  /** Такие же документы старше окна: планшет увидит имя при следующем изменении. */
  outsideWindow: number;
};

export type ImportResult = {
  applied: boolean;
  plan: DirectoriesPlan;
  state: DirectoriesState;
  docs: DocsToTouch;
  snapshot: ImportSnapshot | null;
  /** Есть ли колонка billhub_id (до миграции 0137 dry-run считает её пустой). */
  billhubColumn: boolean;
  timings: { lockWaitMs: number; lockHeldMs: number } | null;
};

export type ImportOptions = {
  apply: boolean;
  /** Первые 16+ символов отпечатка из dry-run. Обязателен при apply. */
  confirm?: string;
  lockTimeoutMs?: number;
  /** Записать снимок; ошибка → ROLLBACK, в базу ничего не попадёт. */
  beforeWrite?: (snapshot: ImportSnapshot) => Promise<void>;
  /** Шов для теста гонки: после всех блокировок, до чтения состояния. */
  afterLock?: () => Promise<void>;
};

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function firstRow<T>(rows: Iterable<unknown>): T | undefined {
  return [...rows][0] as T | undefined;
}

async function hasBillhubColumn(ex: Executor): Promise<boolean> {
  const rows = await ex.execute(sql`
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'suppliers' and column_name = 'billhub_id'
    ) as ok
  `);
  return Boolean(firstRow<{ ok: boolean }>(rows)?.ok);
}

export async function readDirectoriesState(
  ex: Executor,
  opts: { requireBillhubColumn: boolean },
): Promise<DirectoriesState & { billhubColumn: boolean }> {
  const billhubColumn = await hasBillhubColumn(ex);
  if (!billhubColumn && opts.requireBillhubColumn) {
    throw new DirectoriesImportError(
      'no_billhub_column',
      'нет колонки suppliers.billhub_id — миграция 0137 не применена',
    );
  }
  const base = {
    id: suppliers.id,
    inn: suppliers.inn,
    name: suppliers.name,
    aliases: suppliers.aliases,
    lastSecurityStatus: suppliers.lastSecurityStatus,
    foundingDocumentsComment: suppliers.foundingDocumentsComment,
    createdAt: suppliers.createdAt,
  };
  const supplierRows: SupplierRow[] = billhubColumn
    ? await ex.select({ ...base, billhubId: suppliers.billhubId }).from(suppliers)
    : (await ex.select(base).from(suppliers)).map((r) => ({ ...r, billhubId: null }));

  const counts = await ex
    .select({ id: sourceDocuments.supplierDirectoryId, n: sql<number>`count(*)::int` })
    .from(sourceDocuments)
    .where(isNotNull(sourceDocuments.supplierDirectoryId))
    .groupBy(sourceDocuments.supplierDirectoryId);
  const docCounts = new Map<string, number>();
  for (const c of counts) if (c.id) docCounts.set(c.id, Number(c.n));

  const contractors = await ex
    .select({
      id: customerCounterparties.id,
      inn: customerCounterparties.inn,
      name: customerCounterparties.name,
      aliases: customerCounterparties.aliases,
    })
    .from(customerCounterparties);

  return { suppliers: supplierRows, docCounts, contractors, billhubColumn };
}

/** Документы, у которых сменится отображаемое имя поставщика. */
export async function collectDocs(ex: Executor, plan: DirectoriesPlan): Promise<DocsToTouch> {
  const renamed = [...plan.supplierUpdates]
    .filter(([, p]) => p.name !== undefined)
    .map(([id]) => id);
  const sources = new Set(plan.supplierDeletes);
  const ids = [...new Set([...renamed, ...sources])];
  const bySource = new Map<string, string[]>();
  const touchIds: string[] = [];
  let outsideWindow = 0;
  for (const part of chunks(ids, 500)) {
    const rows = await ex
      .select({
        id: sourceDocuments.id,
        supplierId: sourceDocuments.supplierDirectoryId,
        recent: sql<boolean>`${sourceDocuments.updatedAt} >= now() - make_interval(days => ${SYNC_WINDOW_DAYS})`,
      })
      .from(sourceDocuments)
      .where(inArray(sourceDocuments.supplierDirectoryId, part));
    for (const r of rows) {
      if (r.supplierId && sources.has(r.supplierId)) {
        const list = bySource.get(r.supplierId) ?? [];
        list.push(r.id);
        bySource.set(r.supplierId, list);
      }
      if (r.recent) touchIds.push(r.id);
      else outsideWindow += 1;
    }
  }
  for (const list of bySource.values()) list.sort();
  touchIds.sort();
  return { bySource, touchIds, outsideWindow };
}

/**
 * Ключи блокировок по строкам BillHub: ИНН цифрами и как в файле, плюс ключ по
 * имени — тот, что матчер берёт, когда ИНН не распознан.
 */
export function supplierLockKeys(file: readonly BillhubSupplier[]): string[] {
  const keys = new Set<string>();
  for (const f of file) {
    const raw = f.innRaw.trim();
    const digits = innDigits(raw);
    if (digits) keys.add(supplierCreateLockKey(digits, null));
    if (raw) keys.add(supplierCreateLockKey(raw, null));
    const byName = supplierCreateLockKey(null, f.name);
    if (byName) keys.add(byName);
  }
  return [...keys].sort();
}

async function lockKeys(tx: Tx, keys: readonly string[]): Promise<void> {
  for (const part of chunks(keys, 500)) {
    await tx.execute(sql`
      select count(*) from (
        select pg_advisory_xact_lock(hashtext(k))
          from unnest(array[${sql.join(
            part.map((k) => sql`${k}`),
            sql`, `,
          )}]::text[]) as k
      ) locked
    `);
  }
}

function toJson(r: SupplierRow): SupplierRowJson {
  return { ...r, aliases: [...r.aliases], createdAt: r.createdAt.toISOString() };
}

function buildSnapshot(
  state: DirectoriesState,
  plan: DirectoriesPlan,
  docs: DocsToTouch,
  contractorIds: ReadonlyMap<string, string>,
  importedAt: Date,
): ImportSnapshot {
  const supById = new Map(state.suppliers.map((r) => [r.id, r]));
  const ccById = new Map(state.contractors.map((r) => [r.id, r]));
  return {
    version: 1,
    importedAt: importedAt.toISOString(),
    fingerprint: plan.fingerprint,
    supplierUpdates: [...plan.supplierUpdates].map(([id, after]) => {
      const row = supById.get(id)!;
      const before = Object.fromEntries(
        Object.keys(after).map((k) => [k, row[k as keyof SupplierRow]]),
      );
      return { id, before, after };
    }),
    supplierInserts: plan.supplierInserts.map((r) => r.id),
    merges: (plan.merges?.merges ?? []).map((m) => ({
      targetId: m.targetId,
      sources: m.sources.map((s) => ({
        row: toJson(supById.get(s.id)!),
        docIds: docs.bySource.get(s.id) ?? [],
      })),
    })),
    contractorUpdates: [...(plan.contractors?.aliasUpdates ?? [])].map(([id, after]) => ({
      id,
      before: [...ccById.get(id)!.aliases],
      after,
    })),
    contractorInserts: [...contractorIds.values()],
    touchedDocIds: docs.touchIds,
  };
}

function mismatch(what: string, expected: number, actual: number): DirectoriesImportError {
  return new DirectoriesImportError(
    'write_mismatch',
    `${what}: ожидалось ${expected}, затронуто ${actual} — откат`,
  );
}

async function writePlan(
  tx: Tx,
  plan: DirectoriesPlan,
  docs: DocsToTouch,
  contractorIds: ReadonlyMap<string, string>,
  importedAt: Date,
): Promise<void> {
  // 1. Новые строки BillHub — до перепривязки: они бывают целями склейки.
  for (const part of chunks(plan.supplierInserts, 200)) {
    const inserted = await tx
      .insert(suppliers)
      .values(
        part.map((r) => ({
          id: r.id,
          billhubId: r.billhubId,
          inn: r.inn,
          name: r.name,
          aliases: r.aliases,
          lastSecurityStatus: r.lastSecurityStatus,
          foundingDocumentsComment: r.foundingDocumentsComment,
          createdAt: r.createdAt,
          updatedAt: importedAt,
        })),
      )
      .onConflictDoNothing({ target: suppliers.id })
      .returning({ id: suppliers.id });
    if (inserted.length !== part.length)
      throw mismatch('новые поставщики', part.length, inserted.length);
  }

  // 2. Документы источников → цели. updated_at здесь не трогаем — сигнал
  // планшету даёт touch в конце, и только в окне синхронизации.
  for (const m of plan.merges?.merges ?? []) {
    const sourceIds = m.sources.map((s) => s.id);
    const expected = sourceIds.reduce((n, id) => n + (docs.bySource.get(id)?.length ?? 0), 0);
    const moved = await tx
      .update(sourceDocuments)
      .set({ supplierDirectoryId: m.targetId })
      .where(inArray(sourceDocuments.supplierDirectoryId, sourceIds))
      .returning({ id: sourceDocuments.id });
    if (moved.length !== expected)
      throw mismatch(`документы склейки в ${m.targetId}`, expected, moved.length);
  }

  // 3. Правки существующих строк: импорт, алиасы целей, очищенный ИНН.
  for (const [id, patch] of plan.supplierUpdates) {
    const updated = await tx
      .update(suppliers)
      .set({ ...patch, updatedAt: importedAt })
      .where(eq(suppliers.id, id))
      .returning({ id: suppliers.id });
    if (updated.length !== 1) throw mismatch(`поставщик ${id}`, 1, updated.length);
  }

  // 4. Источники склейки — ссылок на них уже нет.
  if (plan.supplierDeletes.length > 0) {
    const deleted = await tx
      .delete(suppliers)
      .where(inArray(suppliers.id, plan.supplierDeletes))
      .returning({ id: suppliers.id });
    if (deleted.length !== plan.supplierDeletes.length) {
      throw mismatch('удалённые дубли', plan.supplierDeletes.length, deleted.length);
    }
  }

  // 5. Подрядчики.
  const ccInserts = plan.contractors?.inserts ?? [];
  if (ccInserts.length > 0) {
    const inserted = await tx
      .insert(customerCounterparties)
      .values(
        ccInserts.map((i) => ({
          id: contractorIds.get(i.key)!,
          inn: i.inn,
          name: i.name,
          aliases: i.aliases,
          createdAt: importedAt,
          updatedAt: importedAt,
        })),
      )
      .returning({ id: customerCounterparties.id });
    if (inserted.length !== ccInserts.length)
      throw mismatch('новые подрядчики', ccInserts.length, inserted.length);
  }
  for (const [id, aliases] of plan.contractors?.aliasUpdates ?? []) {
    const updated = await tx
      .update(customerCounterparties)
      .set({ aliases, updatedAt: importedAt })
      .where(eq(customerCounterparties.id, id))
      .returning({ id: customerCounterparties.id });
    if (updated.length !== 1) throw mismatch(`подрядчик ${id}`, 1, updated.length);
  }

  // 6. Сигнал синхронизации планшету: новое имя поставщика у документов.
  for (const part of chunks(docs.touchIds, 500)) await touchSourceDocuments({ db: tx }, part);
}

/** Итоговые строки должны проходить контракт карточки, иначе «Сохранить» даст 400. */
async function validateWritten(
  tx: Tx,
  plan: DirectoriesPlan,
  contractorIds: ReadonlyMap<string, string>,
): Promise<void> {
  const problems: string[] = [];
  const supplierIds = [...plan.supplierUpdates.keys(), ...plan.supplierInserts.map((r) => r.id)];
  for (const part of chunks(supplierIds, 500)) {
    const rows = await tx.select().from(suppliers).where(inArray(suppliers.id, part));
    for (const r of rows) {
      const res = SupplierUpsertSchema.safeParse({
        inn: r.inn,
        name: r.name,
        aliases: r.aliases,
        lastSecurityStatus: r.lastSecurityStatus,
        foundingDocumentsComment: r.foundingDocumentsComment,
      });
      if (!res.success)
        problems.push(`поставщик ${r.id} «${r.name}»: ${res.error.issues[0]?.message}`);
    }
  }
  const ccIds = [...(plan.contractors?.aliasUpdates.keys() ?? []), ...contractorIds.values()];
  for (const part of chunks(ccIds, 500)) {
    const rows = await tx
      .select()
      .from(customerCounterparties)
      .where(inArray(customerCounterparties.id, part));
    for (const r of rows) {
      const res = CustomerCounterpartyUpsertSchema.safeParse({
        inn: r.inn,
        name: r.name,
        aliases: r.aliases,
        address: r.address,
      });
      if (!res.success)
        problems.push(`подрядчик ${r.id} «${r.name}»: ${res.error.issues[0]?.message}`);
    }
  }
  if (problems.length > 0) {
    throw new DirectoriesImportError(
      'invalid_row',
      `строки не проходят контракт карточки:\n${problems.join('\n')}`,
    );
  }
}

export async function runDirectoriesImport(
  db: Db,
  input: DirectoriesInput,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (!opts.apply) {
    return db.transaction(
      async (tx) => {
        const state = await readDirectoriesState(tx, { requireBillhubColumn: false });
        const plan = buildDirectoriesPlan(input, state);
        const docs = await collectDocs(tx, plan);
        return {
          applied: false,
          plan,
          state,
          docs,
          snapshot: null,
          billhubColumn: state.billhubColumn,
          timings: null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  const confirm = (opts.confirm ?? '').trim().toLowerCase();
  if (confirm.length < FINGERPRINT_SHOWN) {
    throw new DirectoriesImportError(
      'fingerprint',
      `для записи нужен --confirm с первыми ${FINGERPRINT_SHOWN} символами отпечатка из dry-run`,
    );
  }
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new DirectoriesImportError(
      'bad_option',
      `lock timeout должен быть целым > 0, получено ${lockTimeoutMs}`,
    );
  }

  const started = Date.now();
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${lockTimeoutMs}ms'`));
    await tx.execute(sql.raw(`set local statement_timeout = '60s'`));
    const busy = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${IMPORT_LOCK_KEY})) as ok`,
    );
    if (!firstRow<{ ok: boolean }>(busy)?.ok) {
      throw new DirectoriesImportError('busy', 'импорт справочников уже идёт в другой сессии');
    }
    await lockKeys(tx, supplierLockKeys(input.suppliers ?? []));
    await tx.execute(
      sql`lock table suppliers, customer_counterparties in share row exclusive mode`,
    );
    const locked = Date.now();
    await opts.afterLock?.();

    const state = await readDirectoriesState(tx, { requireBillhubColumn: true });
    const plan = buildDirectoriesPlan(input, state);
    if (!plan.fingerprint.startsWith(confirm)) {
      throw new DirectoriesImportError(
        'fingerprint',
        `план изменился после dry-run: сейчас ${plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}, ` +
          `подтверждён ${confirm.slice(0, FINGERPRINT_SHOWN)} — запустите dry-run заново`,
      );
    }

    if (plan.supplierDeletes.length > 0) {
      for (const part of chunks(plan.supplierDeletes, 500)) {
        await tx
          .select({ id: suppliers.id })
          .from(suppliers)
          .where(inArray(suppliers.id, part))
          .for('update');
      }
    }
    const docs = await collectDocs(tx, plan);
    const importedAt = new Date();
    const contractorIds = new Map(
      (plan.contractors?.inserts ?? []).map((i) => [i.key, randomUUID()]),
    );
    const snapshot = buildSnapshot(state, plan, docs, contractorIds, importedAt);
    await opts.beforeWrite?.(snapshot);

    await writePlan(tx, plan, docs, contractorIds, importedAt);
    await validateWritten(tx, plan, contractorIds);

    const after = await readDirectoriesState(tx, { requireBillhubColumn: true });
    const replan = buildDirectoriesPlan(input, after);
    if (replan.opCount > 0) {
      throw new DirectoriesImportError(
        'plan_not_empty',
        `после записи план не пуст (${replan.opCount} операций) — откат, нужен разбор`,
      );
    }
    return {
      applied: true,
      plan,
      state,
      docs,
      snapshot,
      billhubColumn: true,
      timings: { lockWaitMs: locked - started, lockHeldMs: Date.now() - locked },
    };
  });
}
