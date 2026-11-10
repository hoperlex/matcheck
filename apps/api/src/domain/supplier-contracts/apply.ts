// Запись импорта договоров 1С и его откат.
//
// Импорт (dry-run → --apply --confirm):
//   1. dry-run — транзакция repeatable read, read only: состояние, план, отпечаток;
//   2. apply — advisory-lock, повторный план и сверка отпечатка, одно время
//      импорта T (now() до миллисекунд) — оно же в missing_since и applied_at;
//      строка supplier_contract_imports, снимок (до записи, внутри транзакции),
//      запись, повторный план обязан быть пуст.
//
// Откат (--revert snapshot.json): только ДЕЙСТВУЮЩИЙ импорт (последний без
// reverted_at) и только ЦЕЛИКОМ. Любое препятствие — строка изменилась после
// импорта, вставленный договор выбран в приёмке — откат не выполняется вовсе.
// Частичного отката не бывает: иначе каталог остался бы с договорами, а импорт
// числился бы отменённым.
//
// Чтение — сырым SQL с явными приведениями к тексту: postgres.js на свежем
// соединении не знает типов массивов и дат, а drizzle подменяет сериализаторы
// дат у общего клиента (см. память проекта про Date в сыром sql).

import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { ParsedContract } from './parse.js';
import {
  buildContractsPlan,
  CONTRACT_FIELD_KEYS,
  FINGERPRINT_SHOWN,
  type ContractFields,
  type ContractsPlan,
  type ContractsState,
  type ContractStateRow,
} from './plan.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

export const CONTRACTS_IMPORT_LOCK_KEY = 'matcheck:contracts-import';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const CHUNK = 500;

export type ContractsImportErrorCode =
  | 'busy'
  | 'fingerprint'
  | 'mass_missing'
  | 'plan_not_empty'
  | 'bad_option'
  | 'bad_snapshot'
  | 'not_applied'
  | 'already_reverted'
  | 'not_latest'
  | 'obstacles'
  | 'write_mismatch';

export class ContractsImportError extends Error {
  constructor(
    public readonly code: ContractsImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContractsImportError';
  }
}

/** Поля договора с отметкой пропажи — то, что сравнивает и восстанавливает откат. */
export type ContractSnapshotFields = Partial<ContractFields> & { missingSince?: string | null };

export type ContractsImportSnapshot = {
  version: 1;
  kind: 'supplier-contracts-import';
  importId: string;
  fingerprint: string;
  /** Время импорта T, ISO с миллисекундами. */
  appliedAt: string;
  fileName: string;
  fileSha256: string;
  updates: Array<{ id: string; onecId: string; before: ContractSnapshotFields; after: ContractSnapshotFields }>;
  inserts: Array<{ id: string; onecId: string; row: ContractFields }>;
};

export type ImportFileMeta = { fileName: string; fileSha256: string; rowsTotal: number };

export type ImportOptions = {
  apply: boolean;
  confirm?: string;
  allowMassMissing?: boolean;
  lockTimeoutMs?: number;
  /** Вызывается внутри транзакции до записи — CLI пишет снимок на диск. */
  beforeWrite?: (snapshot: ContractsImportSnapshot) => Promise<void> | void;
};

export type ImportResult = {
  applied: boolean;
  plan: ContractsPlan;
  state: ContractsState;
  snapshot: ContractsImportSnapshot | null;
};

function rowsOf<T>(res: Iterable<unknown>): T[] {
  return [...res] as T[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ISO_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Литерал массива uuid для `::uuid[]` — без сериализации массивов драйвером. */
export function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

type RawContractRow = {
  id: string;
  onec_id: string;
  counterparty_onec_id: string | null;
  counterparty_name: string;
  counterparty_inn: string;
  name: string;
  number: string | null;
  contract_date: string | null;
  kind: ContractFields['kind'];
  object_text: string | null;
  site_status: ContractFields['siteStatus'];
  site_ids: string;
  site_rule: string | null;
  missing_since: string | null;
};

function toStateRow(r: RawContractRow): ContractStateRow {
  return {
    id: r.id,
    onecId: r.onec_id,
    counterpartyOnecId: r.counterparty_onec_id,
    counterpartyName: r.counterparty_name,
    counterpartyInn: r.counterparty_inn,
    name: r.name,
    number: r.number,
    contractDate: r.contract_date,
    kind: r.kind,
    objectText: r.object_text,
    siteStatus: r.site_status,
    siteIds: r.site_ids ? r.site_ids.split(',').sort() : [],
    siteRule: r.site_rule,
    missingSince: r.missing_since,
  };
}

const CONTRACT_COLUMNS = sql`
  id::text as id, onec_id::text as onec_id, counterparty_onec_id::text as counterparty_onec_id,
  counterparty_name, counterparty_inn, name, number, contract_date::text as contract_date,
  kind, object_text, site_status, coalesce(array_to_string(site_ids, ','), '') as site_ids,
  site_rule,
  case when missing_since is null then null
       else to_char(missing_since at time zone 'UTC', ${sql.raw(ISO_MS)}) end as missing_since`;

export async function readContractRows(ex: Executor, ids?: readonly string[]): Promise<ContractStateRow[]> {
  if (ids && ids.length === 0) return [];
  const out: ContractStateRow[] = [];
  if (!ids) {
    const res = await ex.execute(sql`select ${CONTRACT_COLUMNS} from supplier_contracts`);
    return rowsOf<RawContractRow>(res).map(toStateRow);
  }
  for (const part of chunks(ids, CHUNK)) {
    const res = await ex.execute(
      sql`select ${CONTRACT_COLUMNS} from supplier_contracts
          where id = any(string_to_array(${part.join(',')}, ',')::uuid[])`,
    );
    out.push(...rowsOf<RawContractRow>(res).map(toStateRow));
  }
  return out;
}

export async function readContractsState(ex: Executor): Promise<ContractsState> {
  const [contracts, sitesRes, linksRes] = await Promise.all([
    readContractRows(ex),
    ex.execute(sql`select id::text as id, code from sites`),
    ex.execute(sql`
      select dc.contract_id::text as contract_id, d.display_id::text as display_id
      from delivery_contracts dc join deliveries d on d.id = dc.delivery_id
      order by d.display_id`),
  ]);
  const sitesByCode = new Map(rowsOf<{ id: string; code: string }>(sitesRes).map((s) => [s.code, s.id]));
  const linkedDeliveries = new Map<string, string[]>();
  for (const l of rowsOf<{ contract_id: string; display_id: string }>(linksRes)) {
    const list = linkedDeliveries.get(l.contract_id) ?? [];
    list.push(l.display_id);
    linkedDeliveries.set(l.contract_id, list);
  }
  return { contracts, sitesByCode, linkedDeliveries };
}

function lockTimeout(ms: number | undefined): number {
  const v = ms ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(v) || v <= 0) {
    throw new ContractsImportError('bad_option', `lock timeout должен быть целым > 0, получено ${v}`);
  }
  return v;
}

async function takeLocks(tx: Tx, lockTimeoutMs: number): Promise<void> {
  await tx.execute(sql.raw(`set local lock_timeout = '${lockTimeoutMs}ms'`));
  await tx.execute(sql.raw(`set local statement_timeout = '120s'`));
  const busy = rowsOf<{ ok: boolean }>(
    await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${CONTRACTS_IMPORT_LOCK_KEY})) as ok`),
  );
  if (!busy[0]?.ok) {
    throw new ContractsImportError('busy', 'импорт или откат договоров уже идёт в другой сессии');
  }
}

/** Время транзакции до миллисекунд, ISO — одно на весь импорт. */
async function transactionTime(tx: Tx): Promise<string> {
  const res = rowsOf<{ t: string }>(
    await tx.execute(
      sql`select to_char(date_trunc('milliseconds', now()) at time zone 'UTC', ${sql.raw(ISO_MS)}) as t`,
    ),
  );
  return res[0]!.t;
}

const COLUMN_BY_FIELD: Record<keyof ContractFields, string> = {
  counterpartyOnecId: 'counterparty_onec_id',
  counterpartyName: 'counterparty_name',
  counterpartyInn: 'counterparty_inn',
  name: 'name',
  number: 'number',
  contractDate: 'contract_date',
  kind: 'kind',
  objectText: 'object_text',
  siteStatus: 'site_status',
  siteIds: 'site_ids',
  siteRule: 'site_rule',
};

/** Значение поля как SQL с явным приведением типа. */
function fieldValue(k: keyof ContractFields, v: unknown): SQL {
  if (k === 'siteIds') return sql`${uuidArrayLiteral(v as string[])}::uuid[]`;
  if (k === 'counterpartyOnecId') return v === null ? sql`null::uuid` : sql`${v as string}::uuid`;
  if (k === 'contractDate') return v === null ? sql`null::date` : sql`${v as string}::date`;
  return v === null ? sql`null` : sql`${v as string}`;
}

function setClause(fields: ContractSnapshotFields, at: string): SQL {
  const parts: SQL[] = [];
  for (const k of CONTRACT_FIELD_KEYS) {
    if (!(k in fields)) continue;
    parts.push(sql`${sql.raw(COLUMN_BY_FIELD[k])} = ${fieldValue(k, fields[k])}`);
  }
  if ('missingSince' in fields) {
    parts.push(
      fields.missingSince === null || fields.missingSince === undefined
        ? sql`missing_since = null`
        : sql`missing_since = ${fields.missingSince}::timestamptz`,
    );
  }
  parts.push(sql`updated_at = ${at}::timestamptz`);
  return sql.join(parts, sql`, `);
}

function buildSnapshot(
  plan: ContractsPlan,
  meta: ImportFileMeta,
  importId: string,
  at: string,
  insertIds: Map<string, string>,
): ContractsImportSnapshot {
  const updates: ContractsImportSnapshot['updates'] = plan.updates.map((u) => {
    const before: ContractSnapshotFields = { ...u.before };
    const after: ContractSnapshotFields = { ...u.after };
    if (u.returnedFrom !== null) {
      before.missingSince = u.returnedFrom;
      after.missingSince = null;
    }
    return { id: u.id, onecId: u.onecId, before, after };
  });
  for (const m of plan.missing) {
    updates.push({ id: m.id, onecId: m.onecId, before: { missingSince: null }, after: { missingSince: at } });
  }
  return {
    version: 1,
    kind: 'supplier-contracts-import',
    importId,
    fingerprint: plan.fingerprint,
    appliedAt: at,
    fileName: meta.fileName,
    fileSha256: meta.fileSha256,
    updates,
    inserts: plan.inserts.map((i) => ({ id: insertIds.get(i.onecId)!, onecId: i.onecId, row: i.fields })),
  };
}

async function writeImport(tx: Tx, snapshot: ContractsImportSnapshot, plan: ContractsPlan, meta: ImportFileMeta) {
  const at = snapshot.appliedAt;
  await tx.execute(sql`
    insert into supplier_contract_imports
      (id, applied_at, file_name, file_sha256, fingerprint, rows_total, inserted, updated, missing, returned)
    values (${snapshot.importId}::uuid, ${at}::timestamptz, ${meta.fileName}, ${meta.fileSha256},
            ${plan.fingerprint}, ${meta.rowsTotal}, ${plan.inserts.length},
            ${plan.updates.filter((u) => u.changed.length > 0).length}, ${plan.missing.length}, ${plan.returned})`);

  for (const part of chunks(snapshot.inserts, CHUNK)) {
    const values = part.map(
      (i) => sql`(${i.id}::uuid, ${i.onecId}::uuid, ${fieldValue('counterpartyOnecId', i.row.counterpartyOnecId)},
        ${i.row.counterpartyName}, ${i.row.counterpartyInn}, ${i.row.name}, ${fieldValue('number', i.row.number)},
        ${fieldValue('contractDate', i.row.contractDate)}, ${i.row.kind}, ${fieldValue('objectText', i.row.objectText)},
        ${i.row.siteStatus}, ${fieldValue('siteIds', i.row.siteIds)}, ${fieldValue('siteRule', i.row.siteRule)},
        ${at}::timestamptz, ${at}::timestamptz)`,
    );
    await tx.execute(sql`
      insert into supplier_contracts
        (id, onec_id, counterparty_onec_id, counterparty_name, counterparty_inn, name, number,
         contract_date, kind, object_text, site_status, site_ids, site_rule, created_at, updated_at)
      values ${sql.join(values, sql`, `)}`);
  }

  for (const u of snapshot.updates) {
    // Пропажа ставится только поверх пустой отметки — охрана от гонки с
    // повторным импортом не нужна (advisory-lock), но и лишнего не перепишем.
    const guard = u.before.missingSince === null && u.after.missingSince ? sql` and missing_since is null` : sql``;
    await tx.execute(
      sql`update supplier_contracts set ${setClause(u.after, at)} where id = ${u.id}::uuid${guard}`,
    );
  }
}

export async function runContractsImport(
  db: Db,
  parsed: readonly ParsedContract[],
  meta: ImportFileMeta,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (!opts.apply) {
    return db.transaction(
      async (tx) => {
        const state = await readContractsState(tx);
        const plan = buildContractsPlan(parsed, state);
        return { applied: false, plan, state, snapshot: null };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  const confirm = (opts.confirm ?? '').trim().toLowerCase();
  if (confirm.length < FINGERPRINT_SHOWN) {
    throw new ContractsImportError(
      'fingerprint',
      `для записи нужен --confirm с первыми ${FINGERPRINT_SHOWN} символами отпечатка из dry-run`,
    );
  }
  const lockTimeoutMs = lockTimeout(opts.lockTimeoutMs);

  return db.transaction(async (tx) => {
    await takeLocks(tx, lockTimeoutMs);
    const state = await readContractsState(tx);
    const plan = buildContractsPlan(parsed, state);
    if (!plan.fingerprint.startsWith(confirm)) {
      throw new ContractsImportError(
        'fingerprint',
        `план изменился после dry-run: сейчас ${plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}, ` +
          `подтверждён ${confirm.slice(0, FINGERPRINT_SHOWN)} — запустите dry-run заново`,
      );
    }
    if (plan.massMissing && !opts.allowMassMissing) {
      throw new ContractsImportError(
        'mass_missing',
        `из выгрузки пропали ${plan.missing.length} из ${plan.liveBefore} договоров (> ${Math.round(
          0.2 * 100,
        )}%) — это похоже на выгрузку другой группы. Если так и задумано — --allow-mass-missing`,
      );
    }
    if (plan.opCount === 0) {
      return { applied: false, plan, state, snapshot: null };
    }

    const at = await transactionTime(tx);
    const importId = randomUUID();
    const insertIds = new Map(plan.inserts.map((i) => [i.onecId, randomUUID()]));
    const snapshot = buildSnapshot(plan, meta, importId, at, insertIds);
    await opts.beforeWrite?.(snapshot);

    await writeImport(tx, snapshot, plan, meta);

    const after = await readContractsState(tx);
    const replan = buildContractsPlan(parsed, after);
    if (replan.opCount > 0) {
      throw new ContractsImportError(
        'plan_not_empty',
        `после записи план не пуст (${replan.opCount} операций) — откат, нужен разбор`,
      );
    }
    return { applied: true, plan, state, snapshot };
  });
}

// ─── Откат ──────────────────────────────────────────────────────────────────

export type RevertObstacle = {
  contractId: string;
  onecId: string;
  reason: 'changed_after_import' | 'inserted_changed' | 'inserted_missing' | 'linked' | 'updated_missing';
  detail: string;
  deliveries?: string[];
};

export type RevertResult = {
  applied: boolean;
  fingerprint: string;
  obstacles: RevertObstacle[];
  restore: number;
  remove: number;
};

export function revertFingerprint(s: ContractsImportSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, revert: s.importId, of: s.fingerprint, u: s.updates.length, i: s.inserts.length }))
    .digest('hex');
}

export function validateSnapshot(raw: unknown): ContractsImportSnapshot {
  const s = raw as Partial<ContractsImportSnapshot> | null;
  if (
    !s ||
    s.version !== 1 ||
    s.kind !== 'supplier-contracts-import' ||
    typeof s.importId !== 'string' ||
    typeof s.appliedAt !== 'string' ||
    !Array.isArray(s.updates) ||
    !Array.isArray(s.inserts)
  ) {
    throw new ContractsImportError('bad_snapshot', 'файл не похож на снимок импорта договоров');
  }
  return s as ContractsImportSnapshot;
}

/** Совпадают ли поля строки со снимком (ключи — только перечисленные в fields). */
function differs(row: ContractStateRow, fields: ContractSnapshotFields): string[] {
  const out: string[] = [];
  for (const k of CONTRACT_FIELD_KEYS) {
    if (!(k in fields)) continue;
    const want = fields[k];
    const have = row[k];
    const same =
      k === 'siteIds'
        ? JSON.stringify([...((have as string[]) ?? [])].sort()) ===
          JSON.stringify([...((want as string[]) ?? [])].sort())
        : have === want;
    if (!same) out.push(k);
  }
  if ('missingSince' in fields && (fields.missingSince ?? null) !== row.missingSince) out.push('missingSince');
  return out;
}

async function checkRevert(tx: Tx, s: ContractsImportSnapshot): Promise<RevertObstacle[]> {
  const imports = rowsOf<{ id: string; reverted_at: string | null }>(
    await tx.execute(sql`
      select id::text as id, reverted_at::text as reverted_at
      from supplier_contract_imports where id = ${s.importId}::uuid`),
  );
  if (imports.length === 0) {
    throw new ContractsImportError(
      'not_applied',
      'импорта из снимка нет в базе — apply не применился (снимок пишется до записи), откатывать нечего',
    );
  }
  if (imports[0]!.reverted_at !== null) {
    throw new ContractsImportError('already_reverted', `импорт ${s.importId} уже откатан`);
  }
  const latest = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id::text as id from supplier_contract_imports
      where reverted_at is null order by applied_at desc, id desc limit 1`),
  );
  if (latest[0]?.id !== s.importId) {
    throw new ContractsImportError(
      'not_latest',
      `откатить можно только действующий (последний) импорт — сейчас это ${latest[0]?.id}; сначала откатите его`,
    );
  }

  const obstacles: RevertObstacle[] = [];
  const updatedRows = new Map((await readContractRows(tx, s.updates.map((u) => u.id))).map((r) => [r.id, r]));
  for (const u of s.updates) {
    const row = updatedRows.get(u.id);
    if (!row) {
      obstacles.push({ contractId: u.id, onecId: u.onecId, reason: 'updated_missing', detail: 'строки нет в базе' });
      continue;
    }
    const diff = differs(row, u.after);
    if (diff.length > 0) {
      obstacles.push({
        contractId: u.id,
        onecId: u.onecId,
        reason: 'changed_after_import',
        detail: `поля изменились после импорта: ${diff.join(', ')}`,
      });
    }
  }

  const insertIds = s.inserts.map((i) => i.id);
  // Блокируем вставленные строки до проверки привязок: FOR UPDATE конфликтует с
  // KEY SHARE, который берёт вставка в delivery_contracts по FK, — привязка,
  // начатая после проверки, дождётся отката и упадёт на FK, а не проскочит.
  for (const part of chunks(insertIds, CHUNK)) {
    await tx.execute(sql`
      select 1 from supplier_contracts
      where id = any(string_to_array(${part.join(',')}, ',')::uuid[]) for update`);
  }
  const insertedRows = new Map((await readContractRows(tx, insertIds)).map((r) => [r.id, r]));
  const links = new Map<string, string[]>();
  for (const part of chunks(insertIds, CHUNK)) {
    const res = rowsOf<{ contract_id: string; display_id: string }>(
      await tx.execute(sql`
        select dc.contract_id::text as contract_id, d.display_id::text as display_id
        from delivery_contracts dc join deliveries d on d.id = dc.delivery_id
        where dc.contract_id = any(string_to_array(${part.join(',')}, ',')::uuid[])`),
    );
    for (const l of res) links.set(l.contract_id, [...(links.get(l.contract_id) ?? []), l.display_id]);
  }
  for (const i of s.inserts) {
    const row = insertedRows.get(i.id);
    if (!row) {
      obstacles.push({ contractId: i.id, onecId: i.onecId, reason: 'inserted_missing', detail: 'строки нет в базе' });
      continue;
    }
    const diff = differs(row, { ...i.row, missingSince: null });
    if (diff.length > 0) {
      obstacles.push({
        contractId: i.id,
        onecId: i.onecId,
        reason: 'inserted_changed',
        detail: `поля изменились после импорта: ${diff.join(', ')}`,
      });
    }
    const linked = links.get(i.id);
    if (linked && linked.length > 0) {
      obstacles.push({
        contractId: i.id,
        onecId: i.onecId,
        reason: 'linked',
        detail: 'договор выбран в приёмках',
        deliveries: linked,
      });
    }
  }
  return obstacles;
}

export async function runContractsRevert(
  db: Db,
  snapshot: ContractsImportSnapshot,
  opts: { apply: boolean; confirm?: string; lockTimeoutMs?: number },
): Promise<RevertResult> {
  const fingerprint = revertFingerprint(snapshot);
  const base = { fingerprint, restore: snapshot.updates.length, remove: snapshot.inserts.length };
  const lockTimeoutMs = lockTimeout(opts.lockTimeoutMs);

  if (!opts.apply) {
    return db.transaction(async (tx) => {
      // dry-run тоже под advisory-lock и FOR UPDATE вставленных строк — чтобы
      // препятствия считались так же, как при записи; транзакция откатывается.
      await takeLocks(tx, lockTimeoutMs);
      const obstacles = await checkRevert(tx, snapshot);
      return { ...base, applied: false, obstacles };
    });
  }

  const confirm = (opts.confirm ?? '').trim().toLowerCase();
  if (confirm.length < FINGERPRINT_SHOWN || !fingerprint.startsWith(confirm)) {
    throw new ContractsImportError(
      'fingerprint',
      `для отката нужен --confirm ${fingerprint.slice(0, FINGERPRINT_SHOWN)} (отпечаток из dry-run отката)`,
    );
  }

  return db.transaction(async (tx) => {
    await takeLocks(tx, lockTimeoutMs);
    const obstacles = await checkRevert(tx, snapshot);
    if (obstacles.length > 0) {
      throw new ContractsImportError(
        'obstacles',
        `откат не выполнен: ${obstacles.length} препятствий (см. dry-run отката) — частичного отката не бывает`,
      );
    }
    const at = await transactionTime(tx);
    for (const u of snapshot.updates) {
      await tx.execute(sql`update supplier_contracts set ${setClause(u.before, at)} where id = ${u.id}::uuid`);
    }
    for (const part of chunks(snapshot.inserts.map((i) => i.id), CHUNK)) {
      await tx.execute(
        sql`delete from supplier_contracts where id = any(string_to_array(${part.join(',')}, ',')::uuid[])`,
      );
    }
    await tx.execute(
      sql`update supplier_contract_imports set reverted_at = ${at}::timestamptz where id = ${snapshot.importId}::uuid`,
    );

    // Сверка: строки равны before, вставленных нет.
    const restored = await readContractRows(tx, snapshot.updates.map((u) => u.id));
    const byId = new Map(restored.map((r) => [r.id, r]));
    const wrong = snapshot.updates.filter((u) => {
      const row = byId.get(u.id);
      return !row || differs(row, u.before).length > 0;
    });
    const leftover = await readContractRows(tx, snapshot.inserts.map((i) => i.id));
    if (wrong.length > 0 || leftover.length > 0) {
      throw new ContractsImportError(
        'write_mismatch',
        `после отката не сошлось: строк не в состоянии «до» — ${wrong.length}, неудалённых — ${leftover.length}`,
      );
    }
    return { ...base, applied: true, obstacles: [] };
  });
}

/** Сводка справочника: число договоров и время действующего импорта. */
export async function readCatalogInfo(ex: Executor): Promise<{ total: number; importedAt: string | null }> {
  const res = rowsOf<{ total: string; imported_at: string | null }>(
    await ex.execute(sql`
      select (select count(*) from supplier_contracts)::text as total,
             (select to_char(applied_at at time zone 'UTC', ${sql.raw(ISO_MS)})
                from supplier_contract_imports where reverted_at is null
                order by applied_at desc, id desc limit 1) as imported_at`),
  );
  return { total: Number(res[0]?.total ?? 0), importedAt: res[0]?.imported_at ?? null };
}
