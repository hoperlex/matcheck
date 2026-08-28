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

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';
import { bundleIdentityHashOf, replaceScopeInIdempotencyKey } from './bundle-key.js';

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
  /** Корень машины; null — документ не из публичной загрузки, он сам по себе. */
  machineRootId: string | null;
  /** Пакеты машины: корень и дочерние, в порядке блокировки. */
  bundleIds: string[];
  /** Все документы машины, включая технические. */
  docs: MachineDoc[];
  /** Документ, который правят. */
  self: MachineDoc;
};

type LockedDocRow = {
  id: string;
  site_id: string | null;
  expected_date_key: string | null;
  is_technical: boolean;
};

/**
 * Блокирует машину документа и возвращает её состав.
 *
 * Вызывать ПЕРВЫМ действием транзакции правки документа — см. порядок
 * блокировок в шапке файла. `null` означает, что документа нет вовсе.
 */
export async function lockMachine(tx: Db, documentId: string): Promise<MachineLock | null> {
  const [head] = await tx
    .select({ bundleId: sourceDocuments.bundleId })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, documentId))
    .limit(1);

  // Корень машины и признак публичной загрузки — до блокировок, чтобы знать, что
  // именно блокировать. Значения перечитываются ниже уже под блокировкой.
  const rootRows = head?.bundleId
    ? await tx.execute<{ root_id: string; is_portal: boolean }>(sql`
        select coalesce(b.parent_bundle_id, b.id) as root_id,
               exists (
                 select 1 from ingest_events ie
                  where ie.bundle_id = coalesce(b.parent_bundle_id, b.id)
                    and ie.channel = 'public'
               ) as is_portal
          from ${sourceBundles} b
         where b.id = ${head.bundleId}::uuid
      `)
    : [];
  const root = [...rootRows][0];
  const machineRootId = root?.is_portal ? root.root_id : null;

  const bundleIds: string[] = [];
  if (machineRootId) {
    // 1) корень, 2) дочерние пакеты по возрастанию id — фиксированный порядок
    // против взаимной блокировки двух правок внутри одного дерева.
    await tx.execute(sql`
      select id from ${sourceBundles} where id = ${machineRootId}::uuid for update
    `);
    const children = await tx.execute<{ id: string }>(sql`
      select id
        from ${sourceBundles}
       where parent_bundle_id = ${machineRootId}::uuid
       order by id
         for update
    `);
    bundleIds.push(machineRootId, ...[...children].map((r) => r.id));
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
         where coalesce(b.parent_bundle_id, b.id) = ${machineRootId}::uuid
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

  return { machineRootId, bundleIds, docs, self };
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

  const [rootRow] = await tx
    .select({ idempotencyKey: sourceBundles.idempotencyKey })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, lock.machineRootId))
    .limit(1);
  const currentKey = rootRow?.idempotencyKey ?? null;
  const nextKey = currentKey ? replaceScopeInIdempotencyKey(currentKey, scope) : null;
  // Ключа нет (legacy-строки до перевода writers) или он чужого формата — не
  // трогаем ничего: уникальность по ключу частичная и на такие пакеты не
  // распространяется, а bundle_hash у них исторический.
  if (!nextKey || !currentKey || nextKey === currentKey) return;

  await tx
    .update(sourceBundles)
    .set({ idempotencyKey: nextKey, bundleHash: bundleIdentityHashOf(nextKey) })
    .where(
      and(
        eq(sourceBundles.id, lock.machineRootId),
        eq(sourceBundles.idempotencyKey, currentKey),
      ),
    );
}
