// Реестр входных файлов пачки (bundle_import_items): выборки, общие для воркера
// и HTTP-роутов.
//
// Живёт в domain, а не в worker.ts, потому что нужен обоим процессам, а
// worker.ts — исполняемый модуль: на верхнем уровне он создаёт Queue, двух
// BullMQ-воркеров, вешает обработчики сигналов и периодические задачи. Импорт
// его из роута поднял бы второго воркера прямо в API-процессе.

import { and, eq, inArray, isNotNull, isNull, or, sql as drSql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { bundleImportItems, sourceBundles, sourceDocuments } from '../../db/schema.js';

export type RegistryRow = {
  id: string;
  bundleId: string;
  s3Key: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /**
   * SHA-256 содержимого (hex), посчитанный при приёме. NULL у строк до
   * миграции 0106. По нему файл повторной отправки сопоставляется со строкой,
   * чей объект так и не попал в S3, — см. selectMissingObjectRows.
   */
  contentSha256: string | null;
  uploadGeneration: number | null;
  /**
   * Порядок файла внутри пачки (0-based), проставленный при приёме.
   *
   * Нужен сборке логических УПД: набор фотографий раскладывается в страницы
   * только по соседству, а порядок выборки из реестра ничем не гарантирован.
   * NULL у строк, созданных до миграции 0096, — для них порядок берётся по
   * createdAt/id.
   */
  inputOrder: number | null;
  status: string;
  processingMode: string;
  detectedKind: string | null;
  confidence: string | null;
  parserUsed: string | null;
  createdDocumentIds: string[];
  reason: string | null;
  // Конечный исход файла, если он расходится с решением router'а: накладная
  // ушла в дочерний пакет (status='created'), а тот кончился ничем.
  effectiveStatus: string | null;
  /**
   * Дочерний пакет, в который уехал файл: накладная — в waybill-разбор, УПД —
   * в сборку логических документов. По нему сборка отбирает свои файлы: в
   * реестре корневого пакета лежат и чужие строки (сертификаты, накладные).
   */
  subBundleId: string | null;
  /**
   * Документ, заведённый по этому файлу, — с настоящим FK, в отличие от
   * createdDocumentIds. Пара (stubDocumentId, resolvedAt) отвечает на вопрос
   * «нужно ли заводить документ»: см. stub-documents.ts.
   */
  stubDocumentId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

const columns = {
  id: bundleImportItems.id,
  bundleId: bundleImportItems.bundleId,
  s3Key: bundleImportItems.inputS3Key,
  filename: bundleImportItems.sourceFilename,
  mimeType: bundleImportItems.mimeType,
  sizeBytes: bundleImportItems.sizeBytes,
  contentSha256: bundleImportItems.contentSha256,
  uploadGeneration: bundleImportItems.uploadGeneration,
  inputOrder: bundleImportItems.inputOrder,
  status: bundleImportItems.status,
  processingMode: bundleImportItems.processingMode,
  detectedKind: bundleImportItems.detectedKind,
  confidence: bundleImportItems.confidence,
  parserUsed: bundleImportItems.parserUsed,
  createdDocumentIds: bundleImportItems.createdDocumentIds,
  reason: bundleImportItems.reason,
  effectiveStatus: bundleImportItems.effectiveStatus,
  subBundleId: bundleImportItems.subBundleId,
  stubDocumentId: bundleImportItems.stubDocumentId,
  resolvedAt: bundleImportItems.resolvedAt,
  createdAt: bundleImportItems.createdAt,
};

/**
 * Строки реестра пакета, относящиеся к ЖИВОЙ загрузке.
 *
 * Правило одно и то же в разборе и в выдаче файлов на портал: если у пакета
 * есть строки активного поколения — берутся только они; иначе fallback на
 * строки без поколения (пакеты, принятые до того, как реестр стал заводиться
 * при приёме). Условие «поколение активное ИЛИ NULL» через OR не годится: оно
 * смешало бы legacy-строки с активной загрузкой и показало файлы брошенной
 * попытки.
 */
export async function selectRegistryRows(
  db: Db,
  bundleId: string,
  activeUploadGeneration: number,
): Promise<RegistryRow[]> {
  const active = await db
    .select(columns)
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.bundleId, bundleId),
        isNotNull(bundleImportItems.inputS3Key),
        eq(bundleImportItems.uploadGeneration, activeUploadGeneration),
      ),
    );
  if (active.length > 0) return active;

  return db
    .select(columns)
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.bundleId, bundleId),
        isNotNull(bundleImportItems.inputS3Key),
        isNull(bundleImportItems.uploadGeneration),
      ),
    );
}

/**
 * Файлы, которые пакет принял, но в хранилище так и не положил.
 *
 * Появляются при частичном сбое S3: девять объектов легли, десятый — нет.
 * Строка о нём заводится всё равно (иначе файл исчезает бесследно и поставщик
 * считает комплект принятым), но БЕЗ `input_s3_key` — ключа нет, потому что нет
 * объекта. Выдавать по такой строке ссылку нельзя, а дозагрузить её — можно и
 * нужно.
 *
 * Отбор по `content_sha256 IS NOT NULL` не косметика, а способ отличить их от
 * legacy-строк: у пакетов, принятых до реестра, ключа тоже нет, но и хеша нет —
 * колонка появилась миграцией 0106. Дозагружать legacy нечем: неизвестно, какой
 * файл к какой строке относится.
 *
 * ВНЕ `selectRegistryRows` намеренно: та отбирает строки с ключом, потому что
 * все её потребители (разбор, сборка, дополнительные файлы) работают с
 * содержимым файла. Здесь ровно наоборот — нужны те, у кого содержимого нет.
 */
export async function selectMissingObjectRows(
  db: Db,
  bundleId: string,
  activeUploadGeneration: number,
): Promise<RegistryRow[]> {
  return db
    .select(columns)
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.bundleId, bundleId),
        isNull(bundleImportItems.inputS3Key),
        isNotNull(bundleImportItems.contentSha256),
        eq(bundleImportItems.status, 'failed'),
        eq(bundleImportItems.uploadGeneration, activeUploadGeneration),
        // Разобранное человеком не переоткрываем: менеджер мог закрыть вопрос
        // руками, и дозагрузка воскресила бы файл, от которого отказались.
        isNull(bundleImportItems.resolvedAt),
      ),
    )
    .orderBy(bundleImportItems.inputOrder);
}

/**
 * Корневой пакет поставки: накладные router разворачивает в ДОЧЕРНИЙ пакет, а
 * дополнительные файлы лежат на родителе. Паттерн тот же, что в public-origin.ts.
 */
export async function resolveRootBundle(
  db: Db,
  bundleId: string,
): Promise<{ id: string; activeUploadGeneration: number } | null> {
  const [row] = await db
    .select({
      id: sourceBundles.id,
      parentBundleId: sourceBundles.parentBundleId,
      activeUploadGeneration: sourceBundles.activeUploadGeneration,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, bundleId))
    .limit(1);
  if (!row) return null;
  if (!row.parentBundleId) {
    return { id: row.id, activeUploadGeneration: row.activeUploadGeneration };
  }

  const [parent] = await db
    .select({
      id: sourceBundles.id,
      activeUploadGeneration: sourceBundles.activeUploadGeneration,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, row.parentBundleId))
    .limit(1);
  return parent ?? { id: row.id, activeUploadGeneration: row.activeUploadGeneration };
}

/**
 * Дополнительные файлы поставки: всё, из чего не вышло живого документа.
 *
 * Это файлы из зоны «Дополнительные документы» (processing_mode='store_only'),
 * сертификаты (`skipped`), файлы, упавшие при обработке (`failed`), строки, не
 * дошедшие до разбора (`needs_review` — legacy-пакеты до реестра), и накладные,
 * чей дочерний пакет кончился ничем (`effective_status='failed'` при
 * status='created'). Всё это иначе не видно нигде: карточки у пакета может не
 * быть, а в «Документах» такие файлы не появляются.
 *
 * Условие «есть ключ S3» обязательно: без него файл не скачать, показывать
 * нечего.
 */
export async function selectExtraFiles(db: Db, bundleId: string): Promise<RegistryRow[]> {
  const root = await resolveRootBundle(db, bundleId);
  if (!root) return [];
  const rows = await selectRegistryRows(db, root.id, root.activeUploadGeneration);
  return rows.filter((r) => r.s3Key !== null && isExtraFileRow(r));
}

/** Строка реестра, не давшая живого документа (см. selectExtraFiles). */
export function isExtraFileRow(r: Pick<RegistryRow, 'status' | 'effectiveStatus'>): boolean {
  if (r.effectiveStatus === 'failed') return true;
  return r.status === 'skipped' || r.status === 'failed' || r.status === 'needs_review';
}

/**
 * Терминальный провал дочернего пакета накладной → родительская строка реестра.
 *
 * Router ставит родительской строке status='created' сразу после постановки
 * дочернего задания — и это честно: решение принято, задание в очереди. Но если
 * дочерний пакет кончился ничем (ни ТН, ни ОС-2 не распознаны; исчерпаны
 * ретраи), файл переставал быть виден вообще: документа нет, строка `created` в
 * дополнительные файлы не попадает, поставщик видит «готово».
 *
 * Конечный исход живёт в effective_status — status трогать нельзя, иначе
 * повторный прогон router'а («created → пропускаем») развернёт файл во второй
 * дочерний пакет.
 */
export async function markSubBundleItemsFailed(
  db: Db,
  subBundleId: string,
  reason: string,
): Promise<{ id: string; filename: string }[]> {
  return db
    .update(bundleImportItems)
    .set({ effectiveStatus: 'failed', reason, updatedAt: new Date() })
    .where(
      and(
        eq(bundleImportItems.subBundleId, subBundleId),
        // Разобранное человеком не переоткрываем.
        isNull(bundleImportItems.resolvedAt),
      ),
    )
    .returning({ id: bundleImportItems.id, filename: bundleImportItems.sourceFilename });
}

/**
 * Дочерний пакет накладной кончился ничем, но файл всё-таки стал видимым
 * документом-заглушкой → родительская строка реестра.
 *
 * Противоположность markSubBundleItemsFailed: тот помечает файл потерянным,
 * этот — дошедшим до результата. Разница важна для блока «дополнительные
 * файлы»: строка с effective_status='failed' попала бы туда (isExtraFileRow), и
 * файл висел бы приложением к собственному документу.
 */
export async function markSubBundleItemDocumented(
  db: Db,
  subBundleId: string,
  documentId: string,
  reason: string,
): Promise<{ id: string }[]> {
  return db
    .update(bundleImportItems)
    .set({
      stubDocumentId: documentId,
      createdDocumentIds: [documentId],
      status: 'created',
      effectiveStatus: 'created',
      reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bundleImportItems.subBundleId, subBundleId),
        // Разобранное человеком не переоткрываем.
        isNull(bundleImportItems.resolvedAt),
      ),
    )
    .returning({ id: bundleImportItems.id });
}

/**
 * Статусы строки, означающие «файл до разбора не дошёл». Терминальными их
 * оставлять нельзя: файл не виден ни в «Документах», ни как дополнительный,
 * пока кто-нибудь не назовёт его исход.
 */
export const NON_TERMINAL_ITEM_STATUSES = ['accepted', 'uploading', 'needs_review'] as const;

/**
 * Инвариант завершённости пакета: у разобранного пакета не остаётся строк «в
 * процессе».
 *
 * Вызывается в конце router-job (штатный путь), при исчерпании ретраев и
 * периодически из repair — крах между обновлением строк и пакета иначе оставил
 * бы файл невидимым навсегда.
 *
 * Строки чужих поколений не трогаем: они относятся к брошенным попыткам
 * загрузки. `upload_generation IS NULL` — legacy-пакеты, принятые до реестра.
 */
export async function finalizeStaleRegistryItems(
  db: Db,
  bundleId: string,
  opts?: { reason?: string; expectedDispatchGeneration?: number },
): Promise<{ id: string; filename: string }[]> {
  return db.transaction(async (rawTx) => {
    const [bundle] = await rawTx
      .select({
        activeUploadGeneration: sourceBundles.activeUploadGeneration,
        dispatchGeneration: sourceBundles.dispatchGeneration,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, bundleId))
      .limit(1)
      .for('update');
    if (!bundle) return [];
    if (
      opts?.expectedDispatchGeneration !== undefined &&
      bundle.dispatchGeneration !== opts.expectedDispatchGeneration
    ) {
      return [];
    }

    return rawTx
      .update(bundleImportItems)
      .set({
        status: 'failed',
        effectiveStatus: 'failed',
        reason: opts?.reason ?? 'файл не дошёл до разбора',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bundleImportItems.bundleId, bundleId),
          inArray(bundleImportItems.status, [...NON_TERMINAL_ITEM_STATUSES]),
          or(
            eq(bundleImportItems.uploadGeneration, bundle.activeUploadGeneration),
            isNull(bundleImportItems.uploadGeneration),
          ),
          // Разобранное человеком не переоткрываем.
          isNull(bundleImportItems.resolvedAt),
        ),
      )
      .returning({ id: bundleImportItems.id, filename: bundleImportItems.sourceFilename });
  });
}

/**
 * Пакеты, которые считаются разобранными, но нарушают инвариант: есть строки
 * реестра «в процессе». Используется периодической проверкой.
 */
export async function selectBundlesWithStaleItems(
  db: Db,
  cutoffMinutes: number,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: sourceBundles.id })
    .from(sourceBundles)
    .where(
      and(
        inArray(sourceBundles.status, ['parsed', 'parse_failed']),
        drSql`${sourceBundles.updatedAt} < now() - make_interval(mins => ${cutoffMinutes})`,
        drSql`exists (
          select 1 from bundle_import_items bi
           where bi.bundle_id = ${sourceBundles.id}
             and bi.status in ('accepted', 'uploading', 'needs_review')
             and bi.resolved_at is null
             and (bi.upload_generation = ${sourceBundles.activeUploadGeneration}
                  or bi.upload_generation is null)
        )`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Файл уже обслужен сборкой логических УПД.
 *
 * Нужен там, где «обслуженность» файла проверяется по вложению с его ключом:
 * сборка склеивает несколько входных файлов в ОДИН документ, и вложение
 * остаётся только у одного из них. Остальные строки комплекта по ключу не
 * находятся и выглядят вечно необслуженными — висят «в очереди» в списке
 * менеджера и держат машину скрытой от планшета.
 *
 * Условия намеренно узкие:
 *   * `parser_used = 'updAssembly'` — в дочерний пакет разворачиваются и
 *     накладные (см. комментарий к `sub_bundle_id` в схеме), поэтому одного
 *     `sub_bundle_id is not null` мало;
 *   * `effective_status = 'created'` + непустой `created_document_ids` — работа
 *     по строке ЗАКОНЧЕНА. Пока дочерний пакет в разборе, строка обязана
 *     оставаться видимой: файл действительно ещё в очереди;
 *   * EXISTS живого нетехнического документа — устаревший идентификатор в
 *     массиве (документ удалили) не должен прятать файл: тогда он снова
 *     ничем не представлен, и это как раз повод показать строку.
 *
 * Значения `created_document_ids` — uuid по построению (их пишет router,
 * читая id вставленных документов). Форма всё равно проверяется регулярным
 * выражением ПЕРЕД приведением: этот предикат стоит в выборке списка документов
 * и в предикате мобильной видимости, и одно нечисловое значение, попавшее в
 * массив мимо router (ручная правка, скрипт восстановления), уронило бы не
 * строку, а весь список и синхронизацию целиком. Сравнение через `::uuid`, а не
 * `sd.id::text`, оставлено ради индекса по первичному ключу.
 */
export function assemblyServedRowSql(alias = 'bi'): SQL {
  const bi = drSql.raw(alias);
  return drSql`(
    ${bi}.parser_used = 'updAssembly'
    and ${bi}.sub_bundle_id is not null
    and ${bi}.effective_status = 'created'
    and jsonb_array_length(${bi}.created_document_ids) > 0
    and exists (
      select 1
        from jsonb_array_elements_text(${bi}.created_document_ids) as did(doc_id)
        join ${sourceDocuments} sd
          on sd.id = case
                       when did.doc_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then did.doc_id::uuid
                     end
       where sd.is_technical = false
    )
  )`;
}
