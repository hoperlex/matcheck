// Захват машины и канонические ключи её корня.
//
// «Машина» — поставка с публичного портала: несколько документов одного рейса,
// разложенных по дереву пакетов (корень + дочерние). Объект и дата поставки —
// её общие свойства, и менеджер правит их одной формой. Поэтому блокировки
// берутся ОДИН раз и передаются обеим операциям переноса: два независимых
// захвата в одном PATCH дали бы лишний круг ожиданий, а два независимых
// пересчёта ключа — гонку за строку корня.
//
// Порядок блокировок: корневой пакет → дочерние пакеты (по id) → документы (по
// id). Тот же порядок начинает воркер (fenceBundleAttempt берёт строку пакета
// раньше любых вставок и создаёт дочерние пакеты под fence родителя), поэтому
// блокировка корня закрывает и появление новых веток дерева. Обратный порядок
// означал бы взаимную блокировку с воркером.
//
// Документ вне публичной загрузки (почта, ЭДО, ручная загрузка, документ без
// пакета) машины не образует: возвращается он один и machineRootId = null. Там
// пачка файлов не означает один рейс, и правка увела бы и соседей, и будущие
// файлы.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';
import { bundleIdentityHashOf, replaceScopeInIdempotencyKey } from './bundle-key.js';

// ─── Замок машины ───────────────────────────────────────────────────────────
//
// Машина может состоять из нескольких отправок (machine_merges): голова и
// участники. Её документы лежат в пакетах разных корней, и бамп «всех
// документов машины» трогает строки, которые одновременно может писать другая
// транзакция — воркер, разбирающий соседний документ, или портал. Без общего
// порядка это цикл: каждый держит свой документ и ждёт чужой. Тот же цикл был
// и до объединений, внутри одной отправки: переразбор писал свой документ, а
// потом бампал всех соседей.
//
// Правило: любая транзакция, которая меняет содержимое или состав машины
// (бамп ревизии, публикация, переходы видимости по машине, слияние,
// разъединение, перенос, создание приёмки с claim), ПЕРВЫМ действием берёт
// строку головы. Тогда ожидать чужой документ может только держатель головы, и
// цикла не остаётся. Функции бампа принимают MachineHeadLock — без захвата их
// не вызвать.

declare const machineHeadLockBrand: unique symbol;

/**
 * Доказательство, что транзакция держит замок машины. Создаётся только
 * lockMachineHead/lockMachine — снаружи модуля его не собрать.
 */
export type MachineHeadLock = {
  readonly [machineHeadLockBrand]: true;
  /** Голова машины; null — у документа нет пакета (ЭДО, почта): машины нет. */
  readonly headId: string | null;
};

function headLockOf(headId: string | null): MachineHeadLock {
  return { headId } as MachineHeadLock;
}

/** Голова сменилась несколько раз подряд, пока мы пытались её захватить. */
export class MachineHeadMovedError extends Error {
  constructor(readonly target: { documentId?: string; bundleId?: string }) {
    super('голова машины меняется прямо сейчас — повторите');
    this.name = 'MachineHeadMovedError';
  }
}

type HeadTarget = { documentId: string } | { bundleId: string };

/**
 * Голова машины без блокировок: корень пакета и его запись в machine_merges.
 * null — документа нет или у него нет пакета.
 */
export async function resolveHead(tx: Db, target: HeadTarget): Promise<string | null> {
  const bundleExpr =
    'documentId' in target
      ? sql`(select bundle_id from ${sourceDocuments} where id = ${target.documentId}::uuid)`
      : sql`${target.bundleId}::uuid`;
  const rows = await tx.execute<{ head_id: string | null }>(sql`
    select coalesce(mm.target_root_id, r.root_id) as head_id
      from (
        select coalesce(b.parent_bundle_id, b.id) as root_id
          from ${sourceBundles} b
         where b.id = ${bundleExpr}
      ) r
      left join machine_merges mm on mm.member_root_id = r.root_id
  `);
  return [...rows][0]?.head_id ?? null;
}

const HEAD_LOCK_ATTEMPTS = 5;

/**
 * Берёт замок машины документа (или пакета): строку головы FOR UPDATE.
 *
 * Вызывать ПЕРВЫМ действием транзакции — до любой записи документов, иначе
 * порядок «голова → участники → дети → документы» нарушен и цикл возвращается.
 *
 * Голову вычисляем до захвата, а слияние или разъединение может закоммититься
 * между вычислением и захватом. Поэтому захват — под точкой сохранения: после
 * него голова перечитывается, и если она сменилась, откат к точке снимает
 * блокировку (строка, запертая отменённой подтранзакцией, свободна), и мы
 * пробуем заново. Вызывающему повторять транзакцию не нужно — это важно для
 * воркера, у которого внутри транзакции есть состояние, не переживающее повтор.
 */
export async function lockMachineHead(tx: Db, target: HeadTarget): Promise<MachineHeadLock> {
  for (let attempt = 0; attempt < HEAD_LOCK_ATTEMPTS; attempt++) {
    const headId = await resolveHead(tx, target);
    if (!headId) return headLockOf(null);
    const stable = await tx
      .transaction(async (sp) => {
        const spDb = sp as unknown as Db;
        await spDb.execute(sql`select id from ${sourceBundles} where id = ${headId}::uuid for update`);
        const again = await resolveHead(spDb, target);
        if (again !== headId) throw new HeadMovedSignal();
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof HeadMovedSignal) return false;
        throw err;
      });
    if (stable) return headLockOf(headId);
  }
  throw new MachineHeadMovedError(target);
}

class HeadMovedSignal extends Error {}

/**
 * Захватывает головы НЕСКОЛЬКИХ машин сразу — для слияния, которое меняет
 * состав всех участвующих машин одной операцией.
 *
 * Порядок — по возрастанию id, как у lockMachinesOrdered: две такие операции
 * встречаются на первой общей голове, а не держат по половине.
 *
 * Перепроверку «голова не сменилась» делает вызывающий: он знает, от каких
 * документов головы вычислены. При расхождении — MachineHeadMovedError и
 * повтор всей транзакции (lib/db-retry.ts).
 */
export async function lockHeadsOrdered(
  tx: Db,
  headIds: string[],
): Promise<Map<string, MachineHeadLock>> {
  const sorted = [...new Set(headIds)].sort();
  for (const id of sorted) {
    await tx.execute(sql`select id from ${sourceBundles} where id = ${id}::uuid for update`);
  }
  return new Map(sorted.map((id) => [id, headLockOf(id)]));
}

/**
 * Захватывает всё, что ниже голов: корни-участники, дочерние пакеты, документы
 * — каждый уровень целиком по возрастанию id. Головы уже захвачены
 * (lockHeadsOrdered), поэтому состав машин здесь стабилен.
 *
 * Возвращает корни каждой головы и id всех документов (включая технические).
 */
export async function lockMachineBodies(
  tx: Db,
  headIds: string[],
): Promise<{ rootsByHead: Map<string, string[]>; documentIds: string[] }> {
  const rootsByHead = new Map<string, string[]>();
  for (const head of [...new Set(headIds)].sort()) {
    rootsByHead.set(head, await machineRootIdsOf(tx, head));
  }
  const allRoots = [...new Set([...rootsByHead.values()].flat())].sort();
  const members = allRoots.filter((id) => !rootsByHead.has(id));
  const idList = (ids: string[]) =>
    sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
  if (members.length > 0) {
    await tx.execute(sql`
      select id from ${sourceBundles} where id in (${idList(members)}) order by id for update
    `);
  }
  if (allRoots.length === 0) return { rootsByHead, documentIds: [] };
  await tx.execute(sql`
    select id from ${sourceBundles}
     where parent_bundle_id in (${idList(allRoots)})
     order by id
       for update
  `);
  const docs = await tx.execute<{ id: string }>(sql`
    select sd.id
      from ${sourceDocuments} sd
      join ${sourceBundles} b on b.id = sd.bundle_id
     where coalesce(b.parent_bundle_id, b.id) in (${idList(allRoots)})
     order by sd.id
       for update of sd
  `);
  return { rootsByHead, documentIds: [...docs].map((r) => r.id) };
}

/**
 * Корни машины, которой правит голова: она сама и её участники, по id.
 * Читать только под замком головы — иначе состав может смениться.
 */
export async function machineRootIdsOf(tx: Db, headId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select ${headId}::uuid as id
    union all
    select member_root_id as id from machine_merges where target_root_id = ${headId}::uuid
  `);
  return [...rows].map((r) => r.id).sort();
}

export type MachineDoc = {
  id: string;
  siteId: string | null;
  /**
   * Дата поставки В ФОРМЕ КЛЮЧА: 'YYYY-MM-DD' либо null.
   *
   * Строкой, а не Date, намеренно. `expected_date` лежит в timestamp БЕЗ
   * таймзоны, и драйвер парсит его как локальное время процесса: при TZ,
   * отличной от UTC, `toISOString().slice(0, 10)` даёт соседний день. Тогда и
   * проверка «дата не изменилась», и компонент канонического ключа разъехались
   * бы с тем, что реально записано в базе. `to_char` в запросе снимает вопрос.
   */
  expectedDateKey: string | null;
  isTechnical: boolean;
};

export type MachineLock = {
  /**
   * Голова машины; null — документ не из публичной загрузки, он сам по себе.
   * У необъединённой машины голова — её корневой пакет, как и раньше.
   */
  machineRootId: string | null;
  /** Корни машины: голова и участники объединения, по id. */
  rootIds: string[];
  /** Пакеты машины: корни и дочерние, в порядке блокировки. */
  bundleIds: string[];
  /** Все документы машины, включая технические. */
  docs: MachineDoc[];
  /** Документ, который правят. */
  self: MachineDoc;
  /** Замок головы — для функций бампа. */
  head: MachineHeadLock;
};

type LockedDocRow = {
  id: string;
  site_id: string | null;
  expected_date_key: string | null;
  is_technical: boolean;
};

/** Есть ли у корня событие публичной загрузки — то есть машина ли это для портала. */
async function isPortalRoot(tx: Db, rootId: string): Promise<boolean> {
  const rows = await tx.execute<{ yes: boolean }>(sql`
    select exists (
      select 1 from ingest_events ie
       where ie.bundle_id = ${rootId}::uuid and ie.channel = 'public'
    ) as yes
  `);
  return [...rows][0]?.yes === true;
}

/**
 * Блокирует машины НЕСКОЛЬКИХ документов — для операций, которые трогают две
 * поставки сразу («Заменить» в разрешении дубликата: удаляется оригинал из
 * одной машины, копия из другой распознаётся заново).
 *
 * Порядок между машинами фиксированный — по ключу «голова машины, иначе id
 * документа», по возрастанию. Внутри машины порядок прежний (lockMachine).
 * Два документа одной машины блокируются дважды одной транзакцией — это
 * безопасно: свои блокировки не ждут.
 *
 * Вызывать ПЕРВЫМ действием транзакции, как и lockMachine.
 */
export async function lockMachinesOrdered(
  tx: Db,
  documentIds: string[],
): Promise<Map<string, MachineLock | null>> {
  const keyed: { id: string; key: string }[] = [];
  for (const id of new Set(documentIds)) {
    keyed.push({ id, key: (await resolveHead(tx, { documentId: id })) ?? id });
  }
  keyed.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const out = new Map<string, MachineLock | null>();
  for (const { id } of keyed) out.set(id, await lockMachine(tx, id));
  return out;
}

/**
 * Блокирует машину документа и возвращает её состав.
 *
 * Порядок: голова (lockMachineHead) → корни-участники по id → дочерние пакеты
 * по id → документы по id. Тот же порядок у слияния и разъединения, а воркер
 * берёт голову раньше любых своих записей.
 *
 * Вызывать ПЕРВЫМ действием транзакции правки документа. `null` означает, что
 * документа нет вовсе.
 */
export async function lockMachine(tx: Db, documentId: string): Promise<MachineLock | null> {
  const head = await lockMachineHead(tx, { documentId });

  // Машина для портала — только публичная загрузка: у почты, ЭДО и внутренних
  // загрузок пачка файлов не означает один рейс, и документ правится один.
  // Голова объединённой машины всегда публичная: слияние других не принимает.
  const machineRootId =
    head.headId && (await isPortalRoot(tx, head.headId)) ? head.headId : null;

  const rootIds: string[] = [];
  const bundleIds: string[] = [];
  if (machineRootId) {
    // Участники читаются под замком головы: всякий, кто пишет machine_merges,
    // сперва берёт голову, значит состав здесь уже не изменится.
    const roots = await machineRootIdsOf(tx, machineRootId);
    const members = roots.filter((id) => id !== machineRootId);
    if (members.length > 0) {
      await tx.execute(sql`
        select id from ${sourceBundles}
         where id in (${sql.join(
           members.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         order by id
           for update
      `);
    }
    // Дочерние пакеты всех корней по возрастанию id — фиксированный порядок
    // против взаимной блокировки двух правок внутри одной машины.
    const children = await tx.execute<{ id: string }>(sql`
      select id
        from ${sourceBundles}
       where parent_bundle_id in (${sql.join(
         roots.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       order by id
         for update
    `);
    rootIds.push(...roots);
    bundleIds.push(machineRootId, ...members, ...[...children].map((r) => r.id));
  }

  // Документы машины — под блокировкой, после пакетов. Технические тоже: из них
  // растут заглушки и сегменты сборки, и объект с датой у них обязаны совпадать.
  const lockedDocs = machineRootId
    ? await tx.execute<LockedDocRow>(sql`
        select sd.id,
               sd.site_id,
               to_char(sd.expected_date, 'YYYY-MM-DD') as expected_date_key,
               sd.is_technical
          from ${sourceDocuments} sd
          join ${sourceBundles} b on b.id = sd.bundle_id
         where coalesce(b.parent_bundle_id, b.id) in (${sql.join(
           rootIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
         order by sd.id
           for update of sd
      `)
    : await tx.execute<LockedDocRow>(sql`
        select sd.id,
               sd.site_id,
               to_char(sd.expected_date, 'YYYY-MM-DD') as expected_date_key,
               sd.is_technical
          from ${sourceDocuments} sd
         where sd.id = ${documentId}::uuid
           for update
      `);
  const docs: MachineDoc[] = [...lockedDocs].map((r) => ({
    id: r.id,
    siteId: r.site_id,
    expectedDateKey: r.expected_date_key,
    isTechnical: r.is_technical,
  }));
  const self = docs.find((d) => d.id === documentId);
  if (!self) return null;

  return { machineRootId, rootIds, bundleIds, docs, self, head };
}

/**
 * Пересчитывает канонические ключи корня под новый scope.
 *
 * Отдельным шагом ПОСЛЕ всех переносов, а не внутри каждого: объект и дата
 * входят в один и тот же ключ, и два пересчёта подряд второй раз читали бы
 * строку, которую первый уже переписал.
 *
 * Ключи корня несут scope. Без пересчёта повторная отправка того же комплекта
 * с ПРЕЖНИМИ объектом и датой узнала бы этот пакет и дописала файлы в машину,
 * которая уже стоит на другом объекте (или на другой день).
 *
 * @param scope компоненты, которые действительно изменились: ключ, не
 *   переданный вовсе, в ключе остаётся прежним.
 */
export async function resyncMachineBundleKeys(
  tx: Db,
  lock: MachineLock,
  scope: { siteId?: string | null; expectedDate?: string | null },
): Promise<void> {
  if (!lock.machineRootId) return;
  if (!('siteId' in scope) && !('expectedDate' in scope)) return;

  // Все корни машины, а не только голова: у объединённой машины каждая
  // отправка несёт свой ключ, и повторная отправка любой из них со старыми
  // объектом или датой иначе узнала бы свой пакет.
  const rootRows = await tx
    .select({ id: sourceBundles.id, idempotencyKey: sourceBundles.idempotencyKey })
    .from(sourceBundles)
    .where(inArray(sourceBundles.id, lock.rootIds.length ? lock.rootIds : [lock.machineRootId]));
  for (const rootRow of rootRows) {
    const currentKey = rootRow.idempotencyKey ?? null;
    const nextKey = currentKey ? replaceScopeInIdempotencyKey(currentKey, scope) : null;
    // Ключа нет (legacy-строки до перевода writers) или он чужого формата — не
    // трогаем ничего: уникальность по ключу частичная и на такие пакеты не
    // распространяется, а bundle_hash у них исторический.
    if (!nextKey || !currentKey || nextKey === currentKey) continue;

    await tx
      .update(sourceBundles)
      .set({ idempotencyKey: nextKey, bundleHash: bundleIdentityHashOf(nextKey) })
      .where(and(eq(sourceBundles.id, rootRow.id), eq(sourceBundles.idempotencyKey, currentKey)));
  }
}
