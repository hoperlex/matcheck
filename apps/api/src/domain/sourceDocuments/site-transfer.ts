// Перенос объекта: у поставки с портала объект — свойство МАШИНЫ, а не строки.
//
// Объект выбирает поставщик на публичной странице: он пишется в пакет и оттуда
// копируется в каждый документ. Если менять его только у одного документа,
// разъезжается всё сразу: машина оказывается на двух объектах, пакет остаётся на
// прежнем (и следующая же дозагрузка, заглушка или пересборка заводят документы
// снова там), а планшет прежнего объекта карточку не отпускает вовсе — дельта
// /sync его больше не привозит, tombstone без смены видимости не пишется,
// reconcile лишнее не удаляет.
//
// Блокировки берёт вызывающий (lockMachine, см. machine-lock.ts) — тем же
// порядком «пакет → документ», что и воркер. Канонические ключи корня тоже
// пересчитывает он: объект и дата поставки входят в ОДИН ключ, и переносу
// каждого поля свой пересчёт не полагается.
//
// Документ вне публичной загрузки (почта, ЭДО, ручная загрузка, документ без
// пакета) переносится ПООДИНОЧКЕ и пакет не трогает: там пачка файлов не
// означает один рейс, и перенос пакета увёл бы и соседей, и будущие файлы.

import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  deliverySources,
  operationGroupClaims,
  shipmentSources,
  sourceBundles,
  sourceDocuments,
} from '../../db/schema.js';
import type { MachineLock } from './machine-lock.js';

export type SiteTransferConflict =
  /** По машине уже оформлена приёмка или отгрузка — объект менять нельзя. */
  { error: 'machine_has_operation'; deliveries: number; shipments: number };

export type SiteTransfer =
  /** Объект не изменился — писать нечего. */
  | { changed: false }
  | {
      changed: true;
      fromSiteId: string | null;
      toSiteId: string | null;
      /** Корень машины; null — документ переносится в одиночку. */
      rootBundleId: string | null;
      /** Нетехнические документы, которым сменили объект. */
      documentIds: string[];
    };

export type SiteTransferOutcome =
  | { ok: true; transfer: SiteTransfer }
  | { conflict: SiteTransferConflict };

/**
 * Нарушение уникальности пакета после пересчёта ключей.
 *
 * Оба ограничения означают одно и то же: такой же комплект файлов в этом scope
 * уже загружен. Ловится ВНЕ транзакции — 23505 обрывает её целиком, и
 * продолжать перенос всё равно нельзя.
 */
export function isBundleScopeUniqueViolation(err: unknown): boolean {
  // По цепочке cause: drizzle заворачивает ошибку драйвера в DrizzleQueryError, и
  // код с именем ограничения лежат уже внутри. Проверять только верхний объект
  // значило бы отдавать 500 ровно в том случае, ради которого функция и нужна.
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (e.code === '23505') {
      const name = e.constraint ?? e.constraint_name ?? '';
      if (
        name === 'source_bundles_bundle_hash_unique' ||
        name === 'source_bundles_idempotency_key_unique'
      ) {
        return true;
      }
    }
    current = e.cause;
  }
  return false;
}

/**
 * Переносит документ (и всю его портальную машину) на другой объект.
 *
 * Машина уже заблокирована вызывающим — значения берутся из `lock`, то есть из
 * строк, прочитанных ПОД блокировкой: значение, прочитанное до транзакции,
 * могло устареть, и два параллельных переноса A→B и A→C оставили бы один из
 * объектов без метки скрытия.
 *
 * Событий видимости здесь нет намеренно — их пишет вызывающий последними
 * операциями транзакции (см. recordSiteTransfer).
 */
export async function transferSite(
  tx: Db,
  lock: MachineLock,
  toSiteId: string | null,
): Promise<SiteTransferOutcome> {
  const fromSiteId = lock.self.siteId;
  if ((fromSiteId ?? null) === (toSiteId ?? null))
    return { ok: true, transfer: { changed: false } };

  const docIds = lock.docs.map((d) => d.id);
  const [{ count: deliveriesCount } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(deliverySources)
    .where(inArray(deliverySources.sourceDocumentId, docIds));
  const [{ count: shipmentsCount } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(shipmentSources)
    .where(inArray(shipmentSources.sourceDocumentId, docIds));
  // Claim пока не занимает никто (enforceGroupClaim в бою не вызывается), но
  // проверка бесплатна и станет значимой в тот день, когда его подключат.
  const claims = lock.machineRootId
    ? await tx
        .select({ groupId: operationGroupClaims.groupId })
        .from(operationGroupClaims)
        .where(eq(operationGroupClaims.groupId, lock.machineRootId))
        .limit(1)
    : [];
  if (deliveriesCount > 0 || shipmentsCount > 0 || claims.length > 0) {
    return {
      conflict: {
        error: 'machine_has_operation',
        deliveries: deliveriesCount,
        shipments: shipmentsCount,
      },
    };
  }

  // Документы: объект плюс признаки изменения для клиентов. updated_at и version
  // бампаются БЕЗУСЛОВНО — дельта /sync отбирает по updated_at, reconcile по
  // version, а bumpGroupRevision условен (рубильник, непортальный пакет) и
  // молча оказался бы no-op'ом, оставив новый объект без машины.
  const visibleIds = lock.docs.filter((d) => !d.isTechnical).map((d) => d.id);
  if (visibleIds.length > 0) {
    await tx.execute(sql`
      update ${sourceDocuments}
         set site_id = ${toSiteId ?? null}::uuid,
             updated_at = statement_timestamp(),
             version = version + 1
       where id in (${sql.join(
         visibleIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
  }
  const technicalIds = lock.docs.filter((d) => d.isTechnical).map((d) => d.id);
  if (technicalIds.length > 0) {
    // Служебные записи на планшет не едут: version им не нужен, а объект нужен —
    // по нему создаются заглушки и сегменты сборки.
    await tx
      .update(sourceDocuments)
      .set({ siteId: toSiteId ?? null, updatedAt: new Date() })
      .where(inArray(sourceDocuments.id, technicalIds));
  }

  if (lock.machineRootId && lock.bundleIds.length > 0) {
    await tx
      .update(sourceBundles)
      .set({ siteId: toSiteId ?? null, updatedAt: new Date() })
      .where(inArray(sourceBundles.id, lock.bundleIds));
  }

  return {
    ok: true,
    transfer: {
      changed: true,
      fromSiteId,
      toSiteId: toSiteId ?? null,
      rootBundleId: lock.machineRootId,
      documentIds: visibleIds,
    },
  };
}

/**
 * Объект машины, каким он записан в БД ПРЯМО СЕЙЧАС.
 *
 * Единственный законный источник объекта для всего, что создаёт документы и
 * дочерние пакеты. Строку пакета воркер читает ДО транзакции, а внутри берёт
 * лишь fence — поэтому задание, ждавшее блокировку во время переноса, после
 * коммита создало бы документ на ПРЕЖНЕМ объекте по значению из памяти. Именно
 * так возвращались бы pending-файлы на объект, с которого машину только что
 * увели.
 *
 * Поднимается к корню: у дочернего пакета (накладная, сборка УПД) объект — это
 * объект машины, а не его собственный.
 */
export async function resolveMachineSiteId(
  tx: Db,
  bundleId: string | null,
): Promise<string | null> {
  if (!bundleId) return null;
  const rows = await tx.execute<{ site_id: string | null }>(sql`
    select coalesce(rb.site_id, b.site_id) as site_id
      from ${sourceBundles} b
      join ${sourceBundles} rb on rb.id = coalesce(b.parent_bundle_id, b.id)
     where b.id = ${bundleId}::uuid
  `);
  return [...rows][0]?.site_id ?? null;
}
