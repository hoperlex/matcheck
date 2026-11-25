// Запись связей «подрядчик × объект» из выгрузки 1С (scripts/import-contractor-sites.ts).
//
// dry-run — одна read-only транзакция (repeatable read): можно под read-only ролью.
// apply — одна транзакция под блокировками, порядок как у карточки контрагента
// (сначала customer_counterparties, потом customer_counterparty_sites):
//   1. lock_timeout/statement_timeout (на бою lock_timeout=0 — ждали бы вечно);
//   2. try-lock на импорт целиком — второй параллельный запуск выходит (код 2);
//   3. LOCK customer_counterparties IN SHARE MODE — на время записи контрагента
//      нельзя переименовать или удалить; карточка (UPDATE этой строки) ждёт;
//   4. LOCK customer_counterparty_sites IN SHARE ROW EXCLUSIVE MODE;
//   5. состояние → план → сверка отпечатка с подтверждённым dry-run;
//   6. снимок слоя onec_* (beforeWrite) → запись → повторный план обязан быть пуст.
// Колонки manual_* не трогает ни одна ветка.
// Редкий случай: объект удаляют в момент записи — возможна 40P01, запуск повторить.

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customerCounterparties, customerCounterpartySites, sites } from '../../db/schema.js';
import type { CcRow } from '../directories/plan-contractors.js';
import {
  buildSnapshot,
  FINGERPRINT_SHOWN,
  planLayer,
  type ContractorSitesPlan,
  type ContractorSitesSnapshot,
  type ContractorSitesState,
  type CurrentLink,
  type TargetEntry,
} from './plan.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export const IMPORT_LOCK_KEY = 'matcheck:contractor-sites-import';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export type ContractorSitesImportErrorCode =
  | 'busy'
  | 'fingerprint'
  | 'plan_not_empty'
  | 'bad_option';

export class ContractorSitesImportError extends Error {
  constructor(
    readonly code: ContractorSitesImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContractorSitesImportError';
  }
}

/** Есть ли таблица 0159 — dry-run можно гонять на базе до миграции (read-only роль). */
export async function contractorSitesTableExists(ex: Executor): Promise<boolean> {
  const res = await ex.execute(
    sql`select to_regclass('public.customer_counterparty_sites') is not null as ok`,
  );
  return Boolean((res as unknown as Array<{ ok: boolean }>)[0]?.ok);
}

export async function readContractorSitesState(
  ex: Executor,
  opts: { tableExists?: boolean } = {},
): Promise<ContractorSitesState> {
  const cc: CcRow[] = (
    await ex
      .select({
        id: customerCounterparties.id,
        inn: customerCounterparties.inn,
        name: customerCounterparties.name,
        aliases: customerCounterparties.aliases,
      })
      .from(customerCounterparties)
  ).map((r) => ({ id: r.id, inn: r.inn ?? '', name: r.name, aliases: r.aliases ?? [] }));
  const siteRows = await ex
    .select({ id: sites.id, code: sites.code, name: sites.name, isActive: sites.isActive })
    .from(sites);
  const linkRows =
    opts.tableExists === false ? [] : await ex.select().from(customerCounterpartySites);
  const links: CurrentLink[] = linkRows.map((l) => ({
    ccId: l.customerCounterpartyId,
    siteId: l.siteId,
    onec:
      l.onecKind === null
        ? null
        : {
            kind: l.onecKind,
            realizationDocs: l.onecRealizationDocs ?? 0,
            realizationSum: l.onecRealizationSum ?? '0.00',
            tollingDocs: l.onecTollingDocs ?? 0,
            tollingSum: l.onecTollingSum ?? '0.00',
            objects: [...(l.onecObjects ?? [])].sort(),
          },
    onecLoadedAt: l.onecLoadedAt,
    manualKind: l.manualKind,
  }));
  return {
    cc,
    sites: siteRows.map((s) => ({ id: s.id, code: s.code, name: s.name, isActive: s.isActive })),
    links,
  };
}

export type ImportOptions = {
  apply: boolean;
  /** Первые 16+ символов отпечатка из dry-run. */
  confirm?: string;
  lockTimeoutMs?: number;
  /** Шов для теста гонки: после всех блокировок, до чтения состояния. */
  afterLock?: () => Promise<void>;
  /** Запись снимка для отката — до первой записи в базу. */
  beforeWrite?: (snapshot: ContractorSitesSnapshot) => Promise<void>;
};

export type ImportResult<T> = {
  applied: boolean;
  /** dry-run на базе без миграции 0159: текущий слой считается пустым. */
  tableMissing: boolean;
  state: ContractorSitesState;
  target: T;
  plan: ContractorSitesPlan;
  snapshot: ContractorSitesSnapshot | null;
  timings: { lockWaitMs: number; lockHeldMs: number } | null;
};

/**
 * Общий движок импорта и отката: `buildTarget` строит целевой слой 1С по
 * состоянию базы (файл — сопоставлением, откат — из снимка).
 */
export async function runContractorSitesImport<T extends { entries: readonly TargetEntry[] }>(
  db: Db,
  buildTarget: (state: ContractorSitesState) => T,
  opts: ImportOptions,
): Promise<ImportResult<T>> {
  if (!opts.apply) {
    return db.transaction(
      async (tx) => {
        const tableExists = await contractorSitesTableExists(tx);
        const state = await readContractorSitesState(tx, { tableExists });
        const target = buildTarget(state);
        return {
          applied: false,
          tableMissing: !tableExists,
          state,
          target,
          plan: planLayer(state, target.entries),
          snapshot: null,
          timings: null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  const confirm = (opts.confirm ?? '').trim().toLowerCase();
  if (confirm.length < FINGERPRINT_SHOWN) {
    throw new ContractorSitesImportError(
      'fingerprint',
      `для записи нужен --confirm с первыми ${FINGERPRINT_SHOWN} символами отпечатка из dry-run`,
    );
  }
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new ContractorSitesImportError(
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
    const ok = (busy as unknown as Array<{ ok: boolean }>)[0]?.ok;
    if (!ok) {
      throw new ContractorSitesImportError(
        'busy',
        'импорт связей с объектами уже идёт в другой сессии',
      );
    }
    await tx.execute(sql`lock table customer_counterparties in share mode`);
    await tx.execute(sql`lock table customer_counterparty_sites in share row exclusive mode`);
    const locked = Date.now();
    await opts.afterLock?.();

    const state = await readContractorSitesState(tx);
    const target = buildTarget(state);
    const plan = planLayer(state, target.entries);
    if (!plan.fingerprint.startsWith(confirm)) {
      throw new ContractorSitesImportError(
        'fingerprint',
        `план изменился после dry-run: сейчас ${plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}, ` +
          `подтверждён ${confirm.slice(0, FINGERPRINT_SHOWN)} — запустите dry-run заново`,
      );
    }
    const now = new Date();
    const snapshot = buildSnapshot(state, plan.fingerprint, now);
    await opts.beforeWrite?.(snapshot);

    await writePlan(tx, plan, now);

    const after = await readContractorSitesState(tx);
    const replan = planLayer(after, buildTarget(after).entries);
    if (replan.ops.length > 0) {
      throw new ContractorSitesImportError(
        'plan_not_empty',
        `после записи план не пуст (${replan.ops.length} операций) — откат, нужен разбор`,
      );
    }
    return {
      applied: true,
      tableMissing: false,
      state,
      target,
      plan,
      snapshot,
      timings: { lockWaitMs: locked - started, lockHeldMs: Date.now() - locked },
    };
  });
}

async function writePlan(tx: Tx, plan: ContractorSitesPlan, now: Date): Promise<void> {
  const upserts = plan.ops.filter((o) => o.type === 'insert' || o.type === 'update');
  for (let i = 0; i < upserts.length; i += 500) {
    const part = upserts.slice(i, i + 500);
    await tx
      .insert(customerCounterpartySites)
      .values(
        part.map((o) => ({
          customerCounterpartyId: o.ccId,
          siteId: o.siteId,
          onecKind: o.after!.kind,
          onecRealizationDocs: o.after!.realizationDocs,
          onecRealizationSum: o.after!.realizationSum,
          onecTollingDocs: o.after!.tollingDocs,
          onecTollingSum: o.after!.tollingSum,
          onecObjects: o.after!.objects,
          onecLoadedAt: o.loadedAt ?? now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          customerCounterpartySites.customerCounterpartyId,
          customerCounterpartySites.siteId,
        ],
        // Только слой 1С: manual_* здесь не перечислены и не меняются.
        set: {
          onecKind: sql`excluded.onec_kind`,
          onecRealizationDocs: sql`excluded.onec_realization_docs`,
          onecRealizationSum: sql`excluded.onec_realization_sum`,
          onecTollingDocs: sql`excluded.onec_tolling_docs`,
          onecTollingSum: sql`excluded.onec_tolling_sum`,
          onecObjects: sql`excluded.onec_objects`,
          onecLoadedAt: sql`excluded.onec_loaded_at`,
          updatedAt: now,
        },
      });
  }
  for (const o of plan.ops) {
    const where = and(
      eq(customerCounterpartySites.customerCounterpartyId, o.ccId),
      eq(customerCounterpartySites.siteId, o.siteId),
    );
    if (o.type === 'clear') {
      await tx
        .update(customerCounterpartySites)
        .set({
          onecKind: null,
          onecRealizationDocs: null,
          onecRealizationSum: null,
          onecTollingDocs: null,
          onecTollingSum: null,
          onecObjects: [],
          onecLoadedAt: null,
          updatedAt: now,
        })
        .where(where);
    } else if (o.type === 'delete') {
      await tx.delete(customerCounterpartySites).where(where);
    }
  }
}
