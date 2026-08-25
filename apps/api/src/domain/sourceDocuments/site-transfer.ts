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
// Поэтому перенос — отдельная операция со своим порядком блокировок:
//   корневой пакет → дочерние пакеты (по id) → документы (по id).
// Тот же порядок начинает воркер (fenceBundleAttempt берёт строку пакета раньше
// любых вставок и создаёт дочерние пакеты под fence родителя), поэтому
// блокировка корня закрывает и появление новых веток дерева.
//
// Документ вне публичной загрузки (почта, ЭДО, ручная загрузка, документ без
// пакета) переносится ПООДИНОЧКЕ и пакет не трогает: там пачка файлов не
// означает один рейс, и перенос пакета увёл бы и соседей, и будущие файлы.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  deliverySources,
  operationGroupClaims,
  shipmentSources,
  sourceBundles,
  sourceDocuments,
} from '../../db/schema.js';
import { bundleIdentityHashOf } from './bundle-key.js';

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
 * Оба ограничения означают одно и то же: такой же комплект файлов на целевом
 * объекте уже загружен. Ловится ВНЕ транзакции — 23505 обрывает её целиком, и
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
 * Подменяет объект в каноническом ключе пакета, сохраняя его версию.
 *
 * Пересобирать ключ из колонок нельзя: формат v2 несёт ещё и `modesHash`
 * (раскладка файлов по зонам формы), а он в source_bundles не хранится —
 * пересборка молча превратила бы v2 в v1, и повторная загрузка той же пачки
 * перестала бы узнаваться. Поэтому правим ровно один компонент.
 *
 * Формат (см. idempotencyKeyOf): `<ver>|manual|<site>|<dir>|<contractor>|<mol>|
 * <date>|<contentHash>[|<modesHash>]` — объект третий по счёту.
 */
export function replaceSiteInIdempotencyKey(key: string, siteId: string | null): string | null {
  const parts = key.split('|');
  // Меньше базовой длины — ключ не нашего формата (ручная правка, чужой backfill).
  // Молча «чинить» его нельзя: получится ключ, которого не построит ни один
  // канал приёма.
  if (parts.length < 8) return null;
  parts[2] = siteId ?? '';
  return parts.join('|');
}

/**
 * Переносит документ (и всю его портальную машину) на другой объект.
 *
 * Вызывать ПЕРВЫМ действием транзакции правки документа: блокировки берутся в
 * порядке «пакет → документ», и обратный порядок дал бы взаимную блокировку с
 * воркером. Событий видимости здесь нет намеренно — их пишет вызывающий
 * последними операциями транзакции (см. recordSiteTransfer).
 */
export async function transferSite(
  tx: Db,
  args: { documentId: string; toSiteId: string | null },
): Promise<SiteTransferOutcome> {
  const { documentId, toSiteId } = args;

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
    // против взаимной блокировки двух переносов внутри одного дерева.
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
  // растут заглушки и сегменты сборки, и объект у них обязан совпадать.
  const lockedDocs = machineRootId
    ? await tx.execute<{ id: string; site_id: string | null; is_technical: boolean }>(sql`
        select sd.id, sd.site_id, sd.is_technical
          from ${sourceDocuments} sd
          join ${sourceBundles} b on b.id = sd.bundle_id
         where coalesce(b.parent_bundle_id, b.id) = ${machineRootId}::uuid
         order by sd.id
           for update of sd
      `)
    : await tx.execute<{ id: string; site_id: string | null; is_technical: boolean }>(sql`
        select sd.id, sd.site_id, sd.is_technical
          from ${sourceDocuments} sd
         where sd.id = ${documentId}::uuid
           for update
      `);
  const docs = [...lockedDocs];
  const self = docs.find((d) => d.id === documentId);
  if (!self) return { ok: true, transfer: { changed: false } };

  // Объект «откуда» читаем ЗАНОВО, из заблокированной строки: значение,
  // прочитанное до транзакции, могло устареть, и два параллельных переноса
  // A→B и A→C оставили бы один из объектов без метки скрытия.
  const fromSiteId = self.site_id;
  if ((fromSiteId ?? null) === (toSiteId ?? null))
    return { ok: true, transfer: { changed: false } };

  const docIds = docs.map((d) => d.id);
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
  const claims = machineRootId
    ? await tx
        .select({ groupId: operationGroupClaims.groupId })
        .from(operationGroupClaims)
        .where(eq(operationGroupClaims.groupId, machineRootId))
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
  const visibleIds = docs.filter((d) => !d.is_technical).map((d) => d.id);
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
  const technicalIds = docs.filter((d) => d.is_technical).map((d) => d.id);
  if (technicalIds.length > 0) {
    // Служебные записи на планшет не едут: version им не нужен, а объект нужен —
    // по нему создаются заглушки и сегменты сборки.
    await tx
      .update(sourceDocuments)
      .set({ siteId: toSiteId ?? null, updatedAt: new Date() })
      .where(inArray(sourceDocuments.id, technicalIds));
  }

  if (machineRootId && bundleIds.length > 0) {
    await tx
      .update(sourceBundles)
      .set({ siteId: toSiteId ?? null, updatedAt: new Date() })
      .where(inArray(sourceBundles.id, bundleIds));

    // Ключи корня несут объект. Без пересчёта повторная отправка того же
    // комплекта на ПРЕЖНИЙ объект узнала бы этот пакет и дописала файлы в
    // машину, которая уже стоит на другом объекте.
    const [rootRow] = await tx
      .select({
        idempotencyKey: sourceBundles.idempotencyKey,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, machineRootId))
      .limit(1);
    const nextKey = rootRow?.idempotencyKey
      ? replaceSiteInIdempotencyKey(rootRow.idempotencyKey, toSiteId ?? null)
      : null;
    // Ключа нет (legacy-строки до перевода writers) или он чужого формата —
    // не трогаем ничего: уникальность по ключу частичная и на такие пакеты не
    // распространяется, а bundle_hash у них исторический.
    if (nextKey) {
      await tx
        .update(sourceBundles)
        .set({ idempotencyKey: nextKey, bundleHash: bundleIdentityHashOf(nextKey) })
        .where(
          and(
            eq(sourceBundles.id, machineRootId),
            eq(sourceBundles.idempotencyKey, rootRow!.idempotencyKey!),
          ),
        );
    }
  }

  return {
    ok: true,
    transfer: {
      changed: true,
      fromSiteId,
      toSiteId: toSiteId ?? null,
      rootBundleId: machineRootId,
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
