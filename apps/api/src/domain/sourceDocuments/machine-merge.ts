// «Объединить в одну машину» и «Разъединить».
//
// Зачем. Сотрудник иногда отправляет документы одного рейса разными отправками
// с /uploads (каждую страницу отдельно, УПД отдельно от накладной). Каждая
// отправка — своя машина, у инспектора несколько карточек, и рейс оформляется
// несколько раз. Менеджер исправляет это на портале.
//
// Что хранится. Документы не меняются. Объединение — строки machine_merges
// «отправка-участник → отправка-голова»; голова машины —
// coalesce(target_root_id, свой корень) (document-group.ts).
//
// Идемпотентность.
//   * Результат определяется НАБОРОМ машин, а не порядком нажатий: если
//     выбранные документы уже в одной машине — `changed: false`, не пишется
//     ничего (двойной клик, вторая вкладка, повтор после обрыва).
//   * Голова выбирается детерминированно: среди уже объединённых машин —
//     самая ранняя отправка, иначе самая ранняя вообще. Цепочек нет: участники
//     поглощаемых голов перенаправляются на новую голову в той же транзакции.
//   * Сервер делает ровно то, что видел менеджер: запрос несёт состав из
//     предпросмотра (`expectedDocumentIds`), расхождение — 409.
//   * «Отменить» привязан к операции (`mergeId`) и не снимет то, что после неё
//     добавил другой менеджер.
//
// Блокировки — общий порядок machine-lock.ts: головы по id → участники →
// дочерние пакеты → документы. Головы вычисляются до захвата, поэтому после
// захвата они перепроверяются; сменились — MachineHeadMovedError и повтор
// транзакции целиком (lib/db-retry.ts).

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceBundles } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { GROUP_CLAIM_CAPABILITY, machineMergeEnabledForSite } from '../groups/claim-scope.js';
import {
  lockHeadsOrdered,
  lockMachine,
  lockMachineBodies,
  MachineHeadMovedError,
} from './machine-lock.js';
import { hasMachineOperations, machineOperations } from './machine-operations.js';
import { recordVisibilityTransitions } from './visibility-events.js';

// ─── Отказы ─────────────────────────────────────────────────────────────────

export type MergeBlocker =
  /** Объединение на объекте не включено (MACHINE_MERGE_SITES). */
  | { code: 'machine_merge_disabled'; siteIds: string[] }
  /** На объекте работают планшеты, не умеющие переносить черновики при смене состава. */
  | { code: 'tablets_not_updated'; sessions: number; userNames: string[] }
  /** Машины для планшета вычисляются по старому правилу (GROUPS_ROLLOUT=0). */
  | { code: 'groups_rollout_off' }
  /** Документ не найден или служебный. */
  | { code: 'not_found'; documentIds: string[] }
  /** Документ не из портальной загрузки (/uploads): машины у него нет. */
  | { code: 'not_portal_upload'; documentIds: string[] }
  /** Отправка старше отсечки GROUPS_ROLLOUT_SINCE: машина по старым правилам. */
  | { code: 'upload_before_rollout'; documentIds: string[] }
  /** Отгрузки не объединяются (в этом выпуске — только приёмка). */
  | { code: 'outbound_not_supported'; documentIds: string[] }
  /** Разные объекты у документов или отправок. */
  | { code: 'different_sites'; values: MergeValueGroup[] }
  /** Разные даты поставки. */
  | { code: 'different_expected_dates'; values: MergeValueGroup[] }
  /** Больше одного получателя (подрядчик или МОЛ). */
  | { code: 'different_recipients'; values: MergeValueGroup[] }
  /** По машине уже есть приёмка, отгрузка, привязка ЭДО или claim. */
  | {
      code: 'machine_has_operation';
      deliveryNumbers: number[];
      shipments: number;
      edoMatches: number;
    };

/** Значение реквизита и документы, у которых оно такое. */
export type MergeValueGroup = { value: string | null; label: string | null; documentIds: string[] };

export type MergeBlockerCode = MergeBlocker['code'];

/** HTTP-статус отказа: 404 — нет документа, 409 — состояние, 422 — несовместимость. */
export function blockerStatus(code: MergeBlockerCode): 404 | 409 | 422 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'machine_merge_disabled':
    case 'tablets_not_updated':
    case 'groups_rollout_off':
    case 'machine_has_operation':
      return 409;
    default:
      return 422;
  }
}

// ─── Состояние машин ────────────────────────────────────────────────────────

type DocRow = {
  id: string;
  root_id: string;
  kind: string;
  doc_number: string | null;
  doc_date: string | null;
  status: string;
  is_technical: boolean;
  direction: string;
  site_id: string | null;
  expected_date_key: string | null;
  supplier_key: string | null;
  supplier_name: string | null;
  contractor_id: string | null;
  contractor_name: string | null;
  recipient_mol_id: string | null;
  recipient_mol_name: string | null;
};

type RootRow = {
  id: string;
  created_at: string;
  site_id: string | null;
  expected_date_key: string | null;
  is_portal: boolean;
};

export type MergeMachineView = {
  headId: string;
  /** Отправки машины: голова первой, затем участники по времени. */
  uploads: Array<{ rootId: string; uploadedAt: string }>;
  /** Машина уже объединённая (больше одной отправки). */
  merged: boolean;
  documents: Array<{
    id: string;
    kind: string;
    docNumber: string | null;
    docDate: string | null;
    status: string;
    supplierName: string | null;
  }>;
};

export type MergeAnalysis = {
  /** Машины выбранных документов. */
  machines: MergeMachineView[];
  /** Голова итоговой машины. */
  targetHeadId: string | null;
  /** Выбранные документы уже в одной машине. */
  alreadyOneMachine: boolean;
  /** Полный состав итоговой машины — нетехнические документы, по id. */
  documentIds: string[];
  siteId: string | null;
  expectedDate: string | null;
  blockers: MergeBlocker[];
  warnings: MergeWarning[];
};

/** Объединить можно, но менеджеру стоит знать. */
export type MergeWarning =
  | { code: 'documents_in_progress'; count: number }
  /**
   * Документы разных поставщиков. Не запрет: так же выглядит машина, загруженная
   * одной отправкой, — у каждого документа свой поставщик (позиции и выгрузка в
   * 1С — по документу), в шапке приёмки — первое непустое (планшет,
   * SourceDocGroup.mergeGroupParty: сначала УПД).
   */
  | { code: 'different_suppliers'; values: MergeValueGroup[] };

/** Головы машин документов, без блокировок. null — у документа нет пакета. */
async function headsOfDocuments(
  tx: Db,
  documentIds: string[],
): Promise<Map<string, string | null>> {
  if (documentIds.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; head_id: string | null }>(sql`
    select sd.id,
           case when b.id is null then null
                else coalesce(mm.target_root_id, coalesce(b.parent_bundle_id, b.id))
           end as head_id
      from source_documents sd
      left join ${sourceBundles} b on b.id = sd.bundle_id
      left join machine_merges mm on mm.member_root_id = coalesce(b.parent_bundle_id, b.id)
     where sd.id in (${sql.join(
       documentIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       and sd.is_technical = false
  `);
  return new Map([...rows].map((r) => [r.id, r.head_id]));
}

async function rootsOfHeads(tx: Db, headIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (headIds.length === 0) return out;
  const rows = await tx.execute<{ head_id: string; root_id: string }>(sql`
    select h.id as head_id, h.id as root_id
      from ${sourceBundles} h
     where h.id in (${sql.join(
       headIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
    union all
    select mm.target_root_id as head_id, mm.member_root_id as root_id
      from machine_merges mm
     where mm.target_root_id in (${sql.join(
       headIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `);
  for (const r of rows) {
    const list = out.get(r.head_id) ?? [];
    list.push(r.root_id);
    out.set(r.head_id, list);
  }
  return out;
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

async function loadRoots(tx: Db, rootIds: string[]): Promise<RootRow[]> {
  if (rootIds.length === 0) return [];
  const rows = await tx.execute<RootRow>(sql`
    select r.id,
           to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
           r.site_id,
           to_char(r.expected_date, 'YYYY-MM-DD') as expected_date_key,
           exists (
             select 1 from ingest_events ie where ie.bundle_id = r.id and ie.channel = 'public'
           ) as is_portal
      from ${sourceBundles} r
     where r.id in (${idList(rootIds)})
  `);
  return [...rows];
}

async function loadDocs(tx: Db, rootIds: string[]): Promise<DocRow[]> {
  if (rootIds.length === 0) return [];
  // Буквальное coalesce(b.parent_bundle_id, b.id) — индекс 0154.
  const rows = await tx.execute<DocRow>(sql`
    select sd.id,
           coalesce(b.parent_bundle_id, b.id) as root_id,
           sd.kind::text as kind,
           sd.doc_number,
           to_char(sd.doc_date, 'YYYY-MM-DD') as doc_date,
           sd.status::text as status,
           sd.is_technical,
           sd.direction::text as direction,
           sd.site_id,
           to_char(sd.expected_date, 'YYYY-MM-DD') as expected_date_key,
           coalesce(sd.supplier_directory_id, sd.supplier_id)::text as supplier_key,
           coalesce(sup_dir.name, sup.name) as supplier_name,
           sd.contractor_id,
           con.name as contractor_name,
           sd.recipient_mol_id,
           mol.full_name as recipient_mol_name
      from source_documents sd
      join ${sourceBundles} b on b.id = sd.bundle_id
      left join suppliers sup_dir on sup_dir.id = sd.supplier_directory_id
      left join counterparties sup on sup.id = sd.supplier_id
      left join counterparties con on con.id = sd.contractor_id
      left join responsible_persons mol on mol.id = sd.recipient_mol_id
     where coalesce(b.parent_bundle_id, b.id) in (${idList(rootIds)})
     order by sd.id
  `);
  return [...rows];
}

/** Сессии инспекторов объекта, активные за неделю, без поддержки протокола занятия. */
async function outdatedTabletSessions(
  tx: Db,
  siteId: string,
): Promise<{ sessions: number; userNames: string[] }> {
  const rows = await tx.execute<{ user_name: string | null }>(sql`
    select coalesce(u.full_name, u.email) as user_name
      from sessions s
      join users u on u.id = s.user_id
     where u.role = 'inspector_kpp'
       and u.site_id = ${siteId}::uuid
       and s.invalidated_at is null
       and s.last_seen_at > now() - interval '7 days'
       and (
         s.last_seen_capabilities is null
         or not (${GROUP_CLAIM_CAPABILITY} = any (string_to_array(s.last_seen_capabilities, ',')))
       )
  `);
  const list = [...rows];
  return {
    sessions: list.length,
    userNames: [...new Set(list.map((r) => r.user_name).filter((n): n is string => !!n))],
  };
}

function groupValues(
  docs: DocRow[],
  valueOf: (d: DocRow) => string | null,
  labelOf: (d: DocRow) => string | null,
  opts: { ignoreNull: boolean },
): MergeValueGroup[] {
  const by = new Map<string, MergeValueGroup>();
  for (const d of docs) {
    const value = valueOf(d);
    if (value === null && opts.ignoreNull) continue;
    const key = value ?? '∅';
    const group = by.get(key) ?? { value, label: labelOf(d), documentIds: [] };
    group.documentIds.push(d.id);
    if (!group.label) group.label = labelOf(d);
    by.set(key, group);
  }
  return [...by.values()];
}

/**
 * Разбор объединения: машины выбранных документов, итоговый состав, отказы.
 *
 * Общий для предпросмотра (без блокировок) и для самого слияния (под
 * блокировками, взятыми mergeMachines): правило одно, и разойтись им нельзя —
 * иначе окно пообещает то, в чём сервер откажет.
 */
export async function analyzeMerge(tx: Db, documentIds: string[]): Promise<MergeAnalysis> {
  const env = loadEnv();
  const blockers: MergeBlocker[] = [];
  const unique = [...new Set(documentIds)];
  const heads = await headsOfDocuments(tx, unique);

  const missing = unique.filter((id) => !heads.has(id));
  if (missing.length) blockers.push({ code: 'not_found', documentIds: missing });
  const withoutBundle = unique.filter((id) => heads.has(id) && heads.get(id) === null);
  if (withoutBundle.length)
    blockers.push({ code: 'not_portal_upload', documentIds: withoutBundle });

  const headIds = [...new Set([...heads.values()].filter((h): h is string => !!h))].sort();
  const rootsByHead = await rootsOfHeads(tx, headIds);
  const allRootIds = [...new Set([...rootsByHead.values()].flat())];
  const roots = await loadRoots(tx, allRootIds);
  const rootById = new Map(roots.map((r) => [r.id, r]));
  const allDocs = await loadDocs(tx, allRootIds);
  const docs = allDocs.filter((d) => !d.is_technical);
  const docsOfRoot = (rootId: string) => docs.filter((d) => d.root_id === rootId);

  // Отправки не с портала — у них нет машины, объединять нечего.
  const nonPortalRoots = roots.filter((r) => !r.is_portal).map((r) => r.id);
  if (nonPortalRoots.length) {
    const ids = nonPortalRoots.flatMap((rid) => docsOfRoot(rid).map((d) => d.id));
    const existing = blockers.find((b) => b.code === 'not_portal_upload');
    if (existing && existing.code === 'not_portal_upload') existing.documentIds.push(...ids);
    else blockers.push({ code: 'not_portal_upload', documentIds: ids });
  }

  if (!env.GROUPS_ROLLOUT) blockers.push({ code: 'groups_rollout_off' });
  const since = env.GROUPS_ROLLOUT_SINCE;
  if (since) {
    const old = roots.filter((r) => new Date(r.created_at) < since).map((r) => r.id);
    if (old.length) {
      blockers.push({
        code: 'upload_before_rollout',
        documentIds: old.flatMap((rid) => docsOfRoot(rid).map((d) => d.id)),
      });
    }
  }

  const outbound = docs.filter((d) => d.direction === 'outbound').map((d) => d.id);
  if (outbound.length) blockers.push({ code: 'outbound_not_supported', documentIds: outbound });

  // Объект и дата — общие свойства машины: у документов и у отправок (новые
  // документы воркер заводит с объектом и датой корня).
  const siteRows: DocRow[] = [
    ...docs,
    ...roots.map(
      (r) =>
        ({
          id: `root:${r.id}`,
          site_id: r.site_id,
          expected_date_key: r.expected_date_key,
        }) as DocRow,
    ),
  ];
  const sites = groupValues(
    siteRows,
    (d) => d.site_id,
    () => null,
    { ignoreNull: false },
  );
  if (sites.length > 1) {
    blockers.push({
      code: 'different_sites',
      values: sites.map((g) => ({
        ...g,
        documentIds: g.documentIds.filter((id) => !id.startsWith('root:')),
      })),
    });
  }
  const dates = groupValues(
    siteRows,
    (d) => d.expected_date_key,
    (d) => d.expected_date_key,
    {
      ignoreNull: false,
    },
  );
  if (dates.length > 1) {
    blockers.push({
      code: 'different_expected_dates',
      values: dates.map((g) => ({
        ...g,
        documentIds: g.documentIds.filter((id) => !id.startsWith('root:')),
      })),
    });
  }

  // Поставщики — предупреждение, не запрет (решение 25.11.2026). Машина с
  // документами разных поставщиков — обычное дело и без объединения: за 60 дней
  // 96 из 510 приёмок с несколькими документами (19 %) содержали разных
  // поставщиков по ИНН — чаще всего УПД + транспортная накладная, где
  // «поставщик» = грузоотправитель. Объединение даёт то же, что загрузка одной
  // отправкой.
  const suppliers = groupValues(
    docs,
    (d) => d.supplier_key,
    (d) => d.supplier_name,
    {
      ignoreNull: true,
    },
  );
  // Получатель — запрет: планшет берёт первое непустое значение
  // (SourceDocGroup.mergeGroupParty), и при двух разных приёмка ушла бы не тому
  // получателю. В боевых приёмках получатели не расходились ни разу.
  const recipients = groupValues(
    docs,
    (d) =>
      d.contractor_id
        ? `contractor:${d.contractor_id}`
        : d.recipient_mol_id
          ? `mol:${d.recipient_mol_id}`
          : null,
    (d) => d.contractor_name ?? d.recipient_mol_name,
    { ignoreNull: true },
  );
  if (recipients.length > 1) blockers.push({ code: 'different_recipients', values: recipients });

  const ops = await machineOperations(
    tx,
    allDocs.map((d) => d.id),
    headIds,
  );
  if (hasMachineOperations(ops)) {
    blockers.push({
      code: 'machine_has_operation',
      deliveryNumbers: ops.deliveryNumbers,
      shipments: ops.shipments,
      edoMatches: ops.edoMatches,
    });
  }

  const siteId = sites.length === 1 ? (sites[0]!.value ?? null) : null;
  const expectedDate = dates.length === 1 ? (dates[0]!.value ?? null) : null;
  const siteIdsInPlay = [
    ...new Set(siteRows.map((d) => d.site_id).filter((s): s is string => !!s)),
  ];
  const disabledSites = siteIdsInPlay.filter((s) => !machineMergeEnabledForSite(s));
  if (disabledSites.length || siteIdsInPlay.length === 0) {
    blockers.unshift({ code: 'machine_merge_disabled', siteIds: disabledSites });
  } else if (siteId) {
    const outdated = await outdatedTabletSessions(tx, siteId);
    if (outdated.sessions > 0) blockers.unshift({ code: 'tablets_not_updated', ...outdated });
  }

  // Голова: среди уже объединённых машин — самая ранняя отправка (черновики,
  // привязанные к её номеру на планшете, остаются на месте), иначе самая
  // ранняя вообще. id — второй ключ, чтобы порядок был полным.
  const headRows = headIds
    .map((id) => rootById.get(id))
    .filter((r): r is RootRow => !!r)
    .map((r) => ({ ...r, merged: (rootsByHead.get(r.id)?.length ?? 0) > 1 }));
  const byAge = (a: RootRow, b: RootRow) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1;
  const mergedHeads = headRows.filter((h) => h.merged).sort(byAge);
  const targetHeadId = (mergedHeads[0] ?? [...headRows].sort(byAge)[0])?.id ?? null;

  const machines: MergeMachineView[] = headIds.map((headId) => {
    const rootIds = rootsByHead.get(headId) ?? [headId];
    const uploads = rootIds
      .map((rid) => rootById.get(rid))
      .filter((r): r is RootRow => !!r)
      .sort((a, b) => (a.id === headId ? -1 : b.id === headId ? 1 : byAge(a, b)))
      .map((r) => ({ rootId: r.id, uploadedAt: r.created_at }));
    return {
      headId,
      uploads,
      merged: rootIds.length > 1,
      documents: docs
        .filter((d) => rootIds.includes(d.root_id))
        .map((d) => ({
          id: d.id,
          kind: d.kind,
          docNumber: d.doc_number,
          docDate: d.doc_date,
          status: d.status,
          supplierName: d.supplier_name,
        })),
    };
  });

  const inProgress = docs.filter((d) => d.status === 'queued' || d.status === 'processing').length;
  const warnings: MergeWarning[] = [];
  if (inProgress) warnings.push({ code: 'documents_in_progress', count: inProgress });
  if (suppliers.length > 1) warnings.push({ code: 'different_suppliers', values: suppliers });
  return {
    machines,
    targetHeadId,
    alreadyOneMachine: headIds.length === 1,
    documentIds: docs.map((d) => d.id).sort(),
    siteId,
    expectedDate,
    blockers,
    warnings,
  };
}

// ─── Слияние ────────────────────────────────────────────────────────────────

export type MergeOutcome =
  | {
      ok: true;
      changed: boolean;
      groupId: string;
      documentIds: string[];
      /** Операция слияния — для «Отменить»; null, если ничего не изменилось. */
      mergeId: string | null;
      /** «Отменить» вернёт ровно прежнее: до слияния ни одна машина не была объединённой. */
      undoable: boolean;
      siteId: string | null;
    }
  | { ok: false; blocker: MergeBlocker }
  | { ok: false; compositionChanged: { documentIds: string[] } };

const sameSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
};

/**
 * Объединяет машины выбранных документов в одну. Вызывать внутри транзакции;
 * блокировки берёт сама — ПЕРВЫМ действием.
 */
export async function mergeMachines(
  tx: Db,
  input: { documentIds: string[]; expectedDocumentIds: string[]; userId: string | null },
): Promise<MergeOutcome> {
  const before = await headsOfDocuments(tx, input.documentIds);
  const heads = [...new Set([...before.values()].filter((h): h is string => !!h))];
  const locks = await lockHeadsOrdered(tx, heads);
  // Голову могли сменить между чтением и захватом (чужое слияние или
  // разъединение) — тогда захвачено не то, повторяем транзакцию целиком.
  const after = await headsOfDocuments(tx, input.documentIds);
  for (const head of after.values()) {
    if (head && !locks.has(head))
      throw new MachineHeadMovedError({ documentId: input.documentIds[0] });
  }
  await lockMachineBodies(tx, heads);

  const analysis = await analyzeMerge(tx, input.documentIds);
  if (analysis.blockers.length > 0) return { ok: false, blocker: analysis.blockers[0]! };
  const target = analysis.targetHeadId!;
  if (analysis.alreadyOneMachine) {
    return {
      ok: true,
      changed: false,
      groupId: target,
      documentIds: analysis.documentIds,
      mergeId: null,
      undoable: false,
      siteId: analysis.siteId,
    };
  }
  if (!sameSet(analysis.documentIds, input.expectedDocumentIds)) {
    return { ok: false, compositionChanged: { documentIds: analysis.documentIds } };
  }

  const absorbed = heads.filter((h) => h !== target).sort();
  const undoable = analysis.machines.every((m) => !m.merged);
  const mergeId = randomUUID();

  // 1) Участники поглощаемых голов — на новую голову (без цепочек). Их
  //    merge_id прежний: «Отменить» этой операции их не снимет.
  await tx.execute(sql`
    update machine_merges set target_root_id = ${target}::uuid
     where target_root_id in (${idList(absorbed)})
  `);
  // 2) Сами поглощаемые головы — участники новой головы.
  await tx.execute(sql`
    insert into machine_merges (member_root_id, target_root_id, merge_id, merged_by_user_id)
    select h, ${target}::uuid, ${mergeId}::uuid, ${input.userId}::uuid
      from unnest(array[${idList(absorbed)}]) as h
  `);
  // 3) Ревизия новой машины — строго больше всего, что видел любой планшет по
  //    любой из голов: max + 1. Линейный рост (+1 за действие).
  await tx.execute(sql`
    update ${sourceBundles}
       set group_revision = (
             select max(group_revision) from ${sourceBundles} where id in (${idList(heads)})
           ) + 1,
           updated_at = statement_timestamp()
     where id = ${target}::uuid
  `);
  // 4) Документы машины — заново на планшет: у них сменились groupId и
  //    ревизия, а дельта /sync отбирает по updated_at, сверка — по version.
  await tx.execute(sql`
    update source_documents
       set updated_at = statement_timestamp(),
           version = version + 1
     where id in (${idList(analysis.documentIds)})
  `);
  // 5) Последним — переходы видимости: машина могла скрыться целиком (сосед в
  //    разборе) или, наоборот, открыться.
  await recordVisibilityTransitions(tx, {
    machine: locks.get(target)!,
    reason: 'машины объединены',
  });

  return {
    ok: true,
    changed: true,
    groupId: target,
    documentIds: analysis.documentIds,
    mergeId,
    undoable,
    siteId: analysis.siteId,
  };
}

// ─── Разъединение ───────────────────────────────────────────────────────────

export type UnmergeOutcome =
  | { ok: true; changed: boolean; documentIds: string[]; rootIds: string[]; siteId: string | null }
  | { ok: false; notFound: true }
  | { ok: false; compositionChanged: { documentIds: string[] } }
  | { ok: false; blocker: Extract<MergeBlocker, { code: 'machine_has_operation' }> };

/**
 * Возвращает отправки машины документа в исходные машины.
 *
 * `expectedDocumentIds` — состав, который видел менеджер; `mergeId` — если
 * отменяют конкретное слияние («Отменить»): тогда отказ, если в машине есть
 * строки другой операции (кто-то добавил документы позже).
 */
export async function unmergeMachine(
  tx: Db,
  input: { documentId: string; expectedDocumentIds: string[]; mergeId?: string | null },
): Promise<UnmergeOutcome> {
  const lock = await lockMachine(tx, input.documentId);
  if (!lock) return { ok: false, notFound: true };
  const documentIds = lock.docs
    .filter((d) => !d.isTechnical)
    .map((d) => d.id)
    .sort();
  if (!lock.machineRootId || lock.rootIds.length <= 1) {
    return {
      ok: true,
      changed: false,
      documentIds,
      rootIds: lock.rootIds,
      siteId: lock.self.siteId,
    };
  }
  if (!sameSet(documentIds, input.expectedDocumentIds)) {
    return { ok: false, compositionChanged: { documentIds } };
  }
  if (input.mergeId) {
    const rows = await tx.execute<{ foreign: number }>(sql`
      select count(*)::int as foreign
        from machine_merges
       where target_root_id = ${lock.machineRootId}::uuid
         and merge_id <> ${input.mergeId}::uuid
    `);
    if (([...rows][0]?.foreign ?? 0) > 0) return { ok: false, compositionChanged: { documentIds } };
  }
  const ops = await machineOperations(
    tx,
    lock.docs.map((d) => d.id),
    [lock.machineRootId],
  );
  if (hasMachineOperations(ops)) {
    return {
      ok: false,
      blocker: {
        code: 'machine_has_operation',
        deliveryNumbers: ops.deliveryNumbers,
        shipments: ops.shipments,
        edoMatches: ops.edoMatches,
      },
    };
  }
  await detachMachine(tx, lock.machineRootId, lock.rootIds, documentIds, 'машина разъединена');
  return { ok: true, changed: true, documentIds, rootIds: lock.rootIds, siteId: lock.self.siteId };
}

/**
 * Снятие объединения без проверок операций — для скрипта обслуживания
 * (machine-merges-retire.ts). Приёмки и связи не трогает: у принятой машины
 * планшет прячет все части (у каждой есть принятый документ), а непринятая
 * часть честно вернётся отдельной карточкой.
 */
export async function retireMachineMerge(
  tx: Db,
  headId: string,
): Promise<{ changed: boolean; documentIds: string[]; rootIds: string[] }> {
  const anyDoc = await tx.execute<{ id: string }>(sql`
    select sd.id
      from source_documents sd
      join ${sourceBundles} b on b.id = sd.bundle_id
     where coalesce(b.parent_bundle_id, b.id) = ${headId}::uuid
     limit 1
  `);
  const first = [...anyDoc][0];
  let rootIds: string[];
  let documentIds: string[];
  if (first) {
    const lock = await lockMachine(tx, first.id);
    if (!lock || lock.machineRootId !== headId)
      return { changed: false, documentIds: [], rootIds: [] };
    rootIds = lock.rootIds;
    documentIds = lock.docs
      .filter((d) => !d.isTechnical)
      .map((d) => d.id)
      .sort();
  } else {
    // У головы нет документов (удалены) — захватываем по пакету.
    const locks = await lockHeadsOrdered(tx, [headId]);
    const body = await lockMachineBodies(tx, [...locks.keys()]);
    rootIds = body.rootsByHead.get(headId) ?? [headId];
    documentIds = [];
  }
  if (rootIds.length <= 1) return { changed: false, documentIds, rootIds };
  await detachMachine(tx, headId, rootIds, documentIds, 'объединение снято при обслуживании');
  return { changed: true, documentIds, rootIds };
}

/** Общая часть разъединения: ревизии, строки machine_merges, бамп, видимость. */
async function detachMachine(
  tx: Db,
  headId: string,
  rootIds: string[],
  documentIds: string[],
  reason: string,
): Promise<void> {
  // Ревизия каждой бывшей отправки — строго больше всего, что видел любой
  // планшет: и по голове (её ревизия ≥ ревизий участников, см. mergeMachines),
  // и по собственному корню. Старый черновик отделённой части увидит смену
  // состава, даже если её содержимое менялось, пока машина была общей.
  await tx.execute(sql`
    update ${sourceBundles}
       set group_revision = greatest(
             group_revision,
             (select group_revision from ${sourceBundles} where id = ${headId}::uuid)
           ) + 1,
           updated_at = statement_timestamp()
     where id in (${idList(rootIds)})
  `);
  await tx.execute(sql`delete from machine_merges where target_root_id = ${headId}::uuid`);
  if (documentIds.length > 0) {
    await tx.execute(sql`
      update source_documents
         set updated_at = statement_timestamp(),
             version = version + 1
       where id in (${idList(documentIds)})
    `);
    await recordVisibilityTransitions(tx, { documentIds, reason });
  }
}
