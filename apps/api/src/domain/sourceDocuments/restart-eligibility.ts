/**
 * Можно ли перезапускать пакет при повторной отправке того же комплекта.
 *
 * Раньше решение принимала `bundleAlreadyProcessed`: есть хотя бы один документ —
 * значит пакет отработан, новой работы нет. Этого мало сразу в двух местах.
 *
 * 1. ЧАСТИЧНОЕ УДАЛЕНИЕ. Менеджер удалил одну УПД из пачки, поставщик прислал
 *    комплект заново. Живой документ у пакета есть, поэтому старая проверка
 *    возвращала «отработан», и удалённая УПД не восстанавливалась никогда.
 *    Поставщику при этом отвечали 201 «принято».
 *
 * 2. ДОКУМЕНТЫ УЖЕ В РАБОТЕ. Обратный случай: перезапускать пакет, чьи документы
 *    привязаны к приёмке или отгрузке, нельзя вовсе. Новое поколение завело бы
 *    вторые документы на те же файлы, а инспекторская операция осталась бы
 *    ссылаться на первые — с расходящимся составом материалов.
 *
 * Поэтому решение теперь четырёхзначное, и «ничего не делать» — это три разных
 * ответа, которые надо различать в логах при разборе инцидента.
 */
import { and, eq, inArray, or, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  deliverySources,
  shipmentSources,
  sourceBundles,
  sourceDocuments,
} from '../../db/schema.js';
import {
  selectMissingObjectRows,
  selectRegistryRows,
  type RegistryRow,
} from './bundle-import-registry.js';

type BundleRow = typeof sourceBundles.$inferSelect;

export type RestartEligibility =
  /** Пакет отработан целиком: все файлы активного поколения дошли до исхода. */
  | { action: 'reuse'; reason: 'processed' }
  /** Часть документов удалена, но остальные уже в приёмке/отгрузке — не трогаем. */
  | { action: 'reuse'; reason: 'locked_by_operation'; operationDocumentIds: string[] }
  /** По пакету прямо сейчас идёт разбор: документ в queued/processing. */
  | { action: 'reuse'; reason: 'busy' }
  /**
   * Часть файлов не долетела до S3 — дозагружаем их в ТО ЖЕ поколение.
   *
   * Отдельный исход, а не разновидность `restart`, потому что restart
   * разрушителен: он поднимает поколение и зовёт `purgePreviousGeneration`,
   * то есть сносит документы девяти успешно принятых файлов ради одного
   * недостающего. Здесь же ничего удалять не нужно — в пакете просто дырка,
   * и её надо заполнить.
   */
  | { action: 'complete_partial'; reason: 'missing_objects'; missingRows: RegistryRow[] }
  /** Комплект неполон и никем не занят — восстанавливаем новым поколением. */
  | { action: 'restart'; reason: 'incomplete'; missingFiles: number };

/**
 * Живые документы пакета — свои и в дочерних пакетах.
 *
 * Дочерние обязательны: накладные router разворачивает в отдельный пакет, и
 * реальный документ ТН/ОС-2 висит уже на нём.
 */
async function liveDocumentIds(db: Db, bundleId: string): Promise<string[]> {
  const child = alias(sourceBundles, 'restart_child_bundle');
  const rows = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .leftJoin(child, eq(child.id, sourceDocuments.bundleId))
    .where(
      and(
        eq(sourceDocuments.isTechnical, false),
        or(eq(sourceDocuments.bundleId, bundleId), eq(child.parentBundleId, bundleId)),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Заняты ли документы операцией.
 *
 * Проверяем и приёмки, и отгрузки: групповой путь отгрузки на планшете такой же,
 * и пакет, чьи документы уехали в отгрузку, перезапускать так же нельзя.
 */
async function documentsUsedByOperations(db: Db, docIds: string[]): Promise<string[]> {
  if (docIds.length === 0) return [];
  const [inDeliveries, inShipments] = await Promise.all([
    db
      .select({ id: deliverySources.sourceDocumentId })
      .from(deliverySources)
      .where(inArray(deliverySources.sourceDocumentId, docIds)),
    db
      .select({ id: shipmentSources.sourceDocumentId })
      .from(shipmentSources)
      .where(inArray(shipmentSources.sourceDocumentId, docIds)),
  ]);
  return [...new Set([...inDeliveries.map((r) => r.id), ...inShipments.map((r) => r.id)])];
}

/**
 * Идёт ли по пакету работа прямо сейчас.
 *
 * Признак один — документ пакета в статусе queued или processing. Перезапуск
 * поверх идущего разбора дал бы два разбора одного файла, и какой результат
 * останется, определял бы порядок завершения.
 *
 * Строку в job_outbox сюда НЕ добавляем, хотя соблазн есть. Задание и служебная
 * запись создаются одной транзакцией, поэтому «задание есть» без записи означает
 * ровно обратное: разбор уже закончился (router удаляет служебную запись в
 * конце) либо пакет брошен, а строка в outbox — недоставленный хвост. Считать
 * такой хвост работой значит навсегда запретить пересборку пакету, чьё задание
 * когда-то застряло.
 */
async function bundleIsBusy(db: Db, bundleId: string): Promise<boolean> {
  // ТЕХНИЧЕСКИЕ ЗАПИСИ ЗДЕСЬ ОБЯЗАТЕЛЬНЫ, в отличие от liveDocumentIds.
  //
  // Между приёмом пачки и разбором у пакета есть ровно один документ — служебная
  // запись router'а в статусе queued, и она техническая. Именно она означает
  // «задание выдано, разбор ещё не начинался». Если её не считать, повторная
  // отправка в это окно выглядела бы как неполный комплект, пакет пересобирался
  // бы поверх идущего разбора, и один файл получил бы два документа.
  //
  // Внутренний вход (dispatch: 'direct') задание в job_outbox не пишет вовсе —
  // оно уходит прямо в BullMQ. Для него служебная запись и есть единственный
  // признак работы.
  const child = alias(sourceBundles, 'busy_child_bundle');
  const [inFlight] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .leftJoin(child, eq(child.id, sourceDocuments.bundleId))
    .where(
      and(
        or(eq(sourceDocuments.bundleId, bundleId), eq(child.parentBundleId, bundleId)),
        inArray(sourceDocuments.status, ['queued', 'processing']),
      ),
    )
    .limit(1);
  return !!inFlight;
}

/**
 * Сколько файлов активного поколения остались без результата.
 *
 * Строка закрыта в двух случаях: она осознанно пропущена (`skipped` — вторая
 * зона и сертификаты) либо по её файлу жив нетехнический документ. Заглушка
 * «не распознано» тоже документ, и это верно: файл виден менеджеру, разбирать
 * его повторной загрузкой незачем.
 *
 * `resolved_at` НЕ закрывает строку. Он означает «router принял по файлу
 * решение», и переживает удаление документа: после ручной чистки строка
 * осталась бы resolved, а показать по ней было бы нечего — ровно тот случай,
 * ради которого пересборка и нужна.
 */
async function countMissingFiles(db: Db, bundle: BundleRow): Promise<number> {
  const rows = await selectRegistryRows(db, bundle.id, bundle.activeUploadGeneration);
  if (rows.length === 0) return 0;

  const liveByKey = new Set<string>();
  const keys = rows.map((r) => r.s3Key).filter((k): k is string => k !== null);
  if (keys.length > 0) {
    const attached = await db.execute<{ s3_key: string }>(drSql`
      select a.s3_key
        from source_document_attachments a
        join source_documents d on d.id = a.source_document_id
       where a.s3_key in ${drSql`(${drSql.join(
         keys.map((k) => drSql`${k}`),
         drSql`, `,
       )})`}
         and d.is_technical = false
    `);
    for (const row of attached) liveByKey.add(row.s3_key);
  }

  return rows.filter((r) => {
    if (r.status === 'skipped') return false;
    if (r.s3Key && liveByKey.has(r.s3Key)) return false;
    return true;
  }).length;
}

/**
 * Убирает документы прошлого поколения перед пересбором пакета.
 *
 * Зачем это обязательно. Рестарт заводит реестр нового поколения на ВСЕ файлы
 * пачки, и router разберёт каждый — включая те, по которым документ уже жив.
 * Без уборки пачка из трёх файлов, где менеджер удалил один документ, дала бы
 * пять: два уцелевших плюс три новых. Инвариант видимости этого не поймал бы —
 * он проверяет «есть ли документ по s3Key», а документ есть.
 *
 * Удалять безопасно ровно потому, что сюда мы попадаем только с вердиктом
 * `restart`: `resolveRestartEligibility` уже убедился, что ни один документ не
 * привязан к приёмке или отгрузке и по пакету не идёт разбор.
 *
 * Tombstone обязателен: документы были видимы на планшетах, и без записи в
 * entity_deletions они остались бы там фантомами до logout/login.
 *
 * Вызывать ВНУТРИ транзакции рестарта.
 */
export async function purgePreviousGeneration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  bundleId: string,
): Promise<string[]> {
  const rows = await tx.execute(drSql`
    select sd.id, sd.site_id
      from source_documents sd
      left join source_bundles b on b.id = sd.bundle_id
     where sd.bundle_id = ${bundleId}
        or b.parent_bundle_id = ${bundleId}
  `);
  const docs = [...rows] as Array<{ id: string; site_id: string | null }>;
  if (docs.length === 0) return [];

  // Технические записи тоже уходят: они принадлежат прошлому прогону router и
  // новому мешают — loadRouterInputs нашёл бы чужую служебную запись.
  await tx.execute(drSql`
    insert into entity_deletions (entity_type, entity_id, site_id)
    select 'source_document', sd.id, sd.site_id
      from source_documents sd
      left join source_bundles b on b.id = sd.bundle_id
     where (sd.bundle_id = ${bundleId} or b.parent_bundle_id = ${bundleId})
       and sd.is_technical = false
  `);
  await tx.execute(drSql`
    delete from source_documents sd
     using source_bundles b
     where b.id = sd.bundle_id
       and b.parent_bundle_id = ${bundleId}
  `);
  await tx.execute(drSql`delete from source_documents where bundle_id = ${bundleId}`);
  // Дочерние пакеты прошлого поколения: их ключи содержат поколение, поэтому
  // новые создадутся рядом, а эти остались бы мусором с висящим статусом.
  await tx.execute(drSql`delete from source_bundles where parent_bundle_id = ${bundleId}`);

  return docs.map((d) => d.id);
}

/**
 * Главный вход. Порядок проверок важен: «занято операцией» и «идёт работа»
 * должны победить «комплект неполон», иначе восстановление затопчет живое.
 */
export async function resolveRestartEligibility(
  db: Db,
  bundle: BundleRow,
): Promise<RestartEligibility> {
  if (await bundleIsBusy(db, bundle.id)) {
    return { action: 'reuse', reason: 'busy' };
  }

  const docIds = await liveDocumentIds(db, bundle.id);

  // Дырка в хранилище проверяется ДО «комплект неполон»: оба условия истинны
  // одновременно (файла нет — значит и документа по нему нет), но лечатся
  // по-разному. Отдать такой пакет в restart значит снести уже разобранное
  // ради одного недолетевшего файла.
  const missingObjects = await selectMissingObjectRows(
    db,
    bundle.id,
    bundle.activeUploadGeneration,
  );
  if (missingObjects.length > 0) {
    // Занятость операцией сильнее: дозагрузка добавила бы документ в машину,
    // которую инспектор уже принял, и состав приёмки разошёлся бы с тем, что
    // он видел. Такой файл разбирает менеджер руками.
    const busyDocs = await documentsUsedByOperations(db, docIds);
    if (busyDocs.length > 0) {
      return { action: 'reuse', reason: 'locked_by_operation', operationDocumentIds: busyDocs };
    }
    return { action: 'complete_partial', reason: 'missing_objects', missingRows: missingObjects };
  }

  const missingFiles = await countMissingFiles(db, bundle);

  // Пачка из одних сертификатов: документов не создаёт, но отработана. Реестр в
  // этом случае целиком в skipped, и missingFiles = 0.
  if (missingFiles === 0) {
    // Реестра может не быть вовсе — legacy-пакеты до миграции 0086. Для них
    // сохраняем прежнее правило «есть документ — значит отработан».
    if (docIds.length > 0) return { action: 'reuse', reason: 'processed' };
    const rows = await selectRegistryRows(db, bundle.id, bundle.activeUploadGeneration);
    if (rows.length > 0 && bundle.status === 'parsed') {
      return { action: 'reuse', reason: 'processed' };
    }
    return { action: 'restart', reason: 'incomplete', missingFiles: rows.length };
  }

  const usedByOperations = await documentsUsedByOperations(db, docIds);
  if (usedByOperations.length > 0) {
    return { action: 'reuse', reason: 'locked_by_operation', operationDocumentIds: usedByOperations };
  }

  return { action: 'restart', reason: 'incomplete', missingFiles };
}
