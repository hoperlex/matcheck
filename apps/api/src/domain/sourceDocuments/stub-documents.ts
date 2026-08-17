// Документ-заглушка для принятого файла, из которого распознавания не вышло.
//
// Инвариант, который держит этот модуль: у каждой строки реестра успешно
// принятого пакета, где есть input_s3_key, нет sub_bundle_id и не проставлен
// resolved_at, существует видимый source_document с вложением-оригиналом.
// Иначе файл лежит в S3, а менеджер видит «ничего не пришло»: список
// «Документы» отбирает по is_technical=false, а файлы без документа доступны
// только во вкладке «Без документов» — и то админу с менеджером.
//
// Потерять файл можно шестью путями (зона «Дополнительные документы»,
// сертификат по классификатору, нераспознанная накладная, исчерпание ретраев,
// сбой getObject, строка, не дошедшая до разбора). Латать каждый по отдельности
// ненадёжно — седьмой появится со следующей фичей, поэтому проверка одна и
// вызывается в конце разбора, из repair и из скрипта бэкфилла.
//
// Живёт в domain, а не в worker.ts, по той же причине, что и реестр рядом:
// worker.ts — исполняемый модуль, на верхнем уровне он поднимает очередь и двух
// BullMQ-воркеров. Импорт его из API-кода или из stuck-jobs поднял бы второго
// воркера прямо в процессе API.

import { and, eq, isNull, sql as drSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { STUB_ERROR_CODES } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  bundleImportItems,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import { headObject } from '../storage/s3.signer.js';
import { manualRecipientSource } from './resolve-contractor.js';
import type { RegistryRow } from './bundle-import-registry.js';

type BundleRow = typeof sourceBundles.$inferSelect;

/**
 * «Это НЕ заглушка» — условие для выдач, куда пустые записи пускать нельзя:
 * планшет КПП (/sync) и «Ожидаемые».
 *
 * Отбор по паре (статус, код), а не по одному коду: `not_processed` рядом с
 * `parse_failed` — обычный документ со сорвавшимся разбором, его прятать
 * нельзя. `archived` в списке статусов намеренно: закрытая вручную заглушка
 * сохраняет код (см. resolveManually), и уезжать на планшет ей по-прежнему
 * незачем.
 *
 * coalesce обязателен: у документа без кода ошибки `NULL in (...)` дало бы NULL,
 * и `not NULL` выбросил бы из выдачи все нормальные документы.
 */
export function notStubDocumentSql() {
  return drSql`not (
    ${sourceDocuments.status} in ('needs_resolution', 'archived')
    and coalesce(${sourceDocuments.parseErrorCode}, '') in (${drSql.join(
      STUB_ERROR_CODES.map((code) => drSql`${code}`),
      drSql`, `,
    )})
  )`;
}

/** Почему по файлу нет настоящего документа. Определяет вид и статус заглушки. */
export type StubReason =
  /** Зона «Дополнительные документы» или сертификат/паспорт качества/декларация. */
  | 'supplementary'
  /** Ни классификатор, ни vision не подтвердили тип. */
  | 'unrecognized_type'
  /** Накладная, в которой не нашлось ни ТН, ни ОС-2. */
  | 'no_waybill_found'
  /** Не скачался из S3, упал разбор, не дошёл до классификации. */
  | 'not_processed';

type StubShape = {
  kind: 'upd' | 'transport_waybill';
  status: 'archived' | 'needs_resolution';
  message: string;
};

/**
 * Вид, статус и текст заглушки.
 *
 * Новых значений в enum source_kind не вводим: незнакомый вид уехал бы
 * мобильному клиенту. Где тип неизвестен — берём 'upd' (общий вход раздела
 * «Документы»), а UI подменяет его на «—» по коду ошибки. У нераспознанной
 * накладной тип ИЗВЕСТЕН, поэтому transport_waybill: «УПД» в колонке «Тип» было
 * бы просто неправдой.
 */
const STUB_SHAPES: Record<StubReason, StubShape> = {
  // Разбирать нечего — реквизиты сопроводительного документа никому не нужны.
  // Поэтому сразу archived: файл виден и открывается, но не изображает работу.
  supplementary: {
    kind: 'upd',
    status: 'archived',
    message: 'сопроводительный документ — распознавание не требуется',
  },
  unrecognized_type: {
    kind: 'upd',
    status: 'needs_resolution',
    message: 'тип документа не определён — требуется ручной разбор',
  },
  no_waybill_found: {
    kind: 'transport_waybill',
    status: 'needs_resolution',
    message: 'накладная не распознана — ни ТН, ни ОС-2 не найдены',
  },
  not_processed: {
    kind: 'upd',
    status: 'needs_resolution',
    message: 'файл принят, но распознать его не удалось — требуется ручной разбор',
  },
};

export type EnsureStubResult =
  | { action: 'created'; documentId: string }
  /** Показали техническую запись, которая уже держала этот файл. */
  | { action: 'promoted'; documentId: string }
  /** Документ по файлу уже есть — ничего не делали. */
  | { action: 'exists'; documentId: string | null }
  /** Вопрос по файлу закрыт человеком (в том числе удалением документа). */
  | { action: 'resolved' }
  /** Объекта нет в S3: документ без файла заводить нельзя. */
  | { action: 'missing_object' };

/**
 * Есть ли по файлу живой видимый документ.
 *
 * Смотрим на вложение с тем же s3_key, а не на created_document_ids: последний
 * — jsonb без FK, он переживает удаление документа и продолжает указывать в
 * пустоту. Страховка нужна для строк, заведённых до появления stub_document_id.
 */
async function findLiveDocumentByKey(db: Db, s3Key: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .innerJoin(
      sourceDocumentAttachments,
      eq(sourceDocumentAttachments.sourceDocumentId, sourceDocuments.id),
    )
    .where(and(eq(sourceDocumentAttachments.s3Key, s3Key), eq(sourceDocuments.isTechnical, false)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Техническая запись, которая уже держит этот файл, — из ЗАВЕРШЁННОГО пакета.
 *
 * Так выглядит нераспознанная накладная: router развернул файл в дочерний
 * пакет, waybill-парсер не нашёл ни ТН, ни ОС-2, и оригинал остался висеть на
 * служебной записи. Заводить рядом вторую — значит получить два документа на
 * один файл; правильно показать эту.
 *
 * Условие «пакет завершён» обязательно: пока разбор идёт, служебная запись
 * живёт по делу и трогать её нельзя. Технические документы сборки логических
 * УПД сюда не попадают — их пакет остаётся в processing до публикации.
 */
async function findTechnicalDocumentByKey(db: Db, s3Key: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .innerJoin(
      sourceDocumentAttachments,
      eq(sourceDocumentAttachments.sourceDocumentId, sourceDocuments.id),
    )
    .innerJoin(sourceBundles, eq(sourceBundles.id, sourceDocuments.bundleId))
    .where(
      and(
        eq(sourceDocumentAttachments.s3Key, s3Key),
        eq(sourceDocuments.isTechnical, true),
        drSql`${sourceBundles.status} in ('parsed', 'parse_failed')`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Заводит заглушку по строке реестра, если её ещё нет.
 *
 * Идемпотентна и безопасна при гонке router-job с repair: проверка состояния и
 * вставка идут одной транзакцией под `SELECT … FOR UPDATE` по строке реестра.
 * Проверка повторяется ВНУТРИ транзакции — за время похода в S3 состояние мог
 * изменить параллельный проход.
 *
 * headObject — до транзакции: сетевой вызов под блокировкой держал бы строку
 * всё время похода в S3. Объекта нет → документ не создаём: запись без файла
 * выглядела бы как документ, но не открывалась.
 */
export async function ensureDocumentForRegistryRow(args: {
  db: Db;
  row: Pick<RegistryRow, 'id' | 'bundleId' | 'filename' | 'mimeType' | 'sizeBytes'> & {
    s3Key: string;
  };
  bundle: BundleRow;
  reason: StubReason;
  /** Текст для реестра, если у вызывающего он точнее общего. */
  reasonText?: string;
}): Promise<EnsureStubResult> {
  const { db, row, bundle, reason } = args;
  const shape = STUB_SHAPES[reason];
  const reasonText = args.reasonText ?? shape.message;

  // Сетевая ошибка (не 404) пробрасывается наружу намеренно: пометить файл
  // «исходник недоступен» из-за моргнувшей сети значило бы соврать. Вызывающий
  // повторит на следующем проходе.
  if (!(await headObject(row.s3Key))) {
    await db
      .update(bundleImportItems)
      .set({
        status: 'failed',
        effectiveStatus: 'failed',
        reason: 'исходник недоступен: объекта нет в хранилище',
        updatedAt: new Date(),
      })
      .where(eq(bundleImportItems.id, row.id));
    return { action: 'missing_object' };
  }

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: bundleImportItems.id,
        resolvedAt: bundleImportItems.resolvedAt,
        stubDocumentId: bundleImportItems.stubDocumentId,
      })
      .from(bundleImportItems)
      .where(eq(bundleImportItems.id, row.id))
      .limit(1)
      .for('update');
    if (!locked) return { action: 'resolved' as const };
    if (locked.resolvedAt) return { action: 'resolved' as const };

    if (locked.stubDocumentId) {
      const [alive] = await tx
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, locked.stubDocumentId))
        .limit(1);
      if (alive) return { action: 'exists' as const, documentId: alive.id };
    }

    const live = await findLiveDocumentByKey(tx as unknown as Db, row.s3Key);
    if (live) return { action: 'exists' as const, documentId: live };

    // Файл уже держит служебная запись завершённого пакета (так выглядит
    // нераспознанная накладная) — показываем её, а не заводим вторую.
    const technical = await findTechnicalDocumentByKey(tx as unknown as Db, row.s3Key);
    if (technical) {
      await tx
        .update(sourceDocuments)
        .set({
          isTechnical: false,
          status: shape.status,
          parseErrorCode: reason,
          parseErrorDetails: { message: reasonText },
          originalFilename: row.filename,
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, technical));
      await tx
        .update(bundleImportItems)
        .set({
          stubDocumentId: technical,
          createdDocumentIds: [technical],
          status: 'created',
          effectiveStatus: 'created',
          reason: reasonText,
          updatedAt: new Date(),
        })
        .where(eq(bundleImportItems.id, row.id));
      return { action: 'promoted' as const, documentId: technical };
    }

    const docId = randomUUID();
    await tx.insert(sourceDocuments).values({
      id: docId,
      kind: shape.kind,
      direction: bundle.direction,
      origin: bundle.origin ?? 'manual_pdf',
      status: shape.status,
      parseErrorCode: reason,
      parseErrorDetails: { message: reasonText },
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      recipientSource: manualRecipientSource(bundle),
      siteId: bundle.siteId,
      expectedDate: bundle.expectedDate,
      originalFilename: row.filename,
      // Разбор завершён и не начнётся снова: заглушку ждёт человек, а не
      // очередь. Задание намеренно не ставим — распознавать нечем.
      processedAt: new Date(),
      bundleId: row.bundleId,
      createdByUserId: bundle.createdByUserId,
    });
    await tx.insert(sourceDocumentAttachments).values({
      sourceDocumentId: docId,
      s3Key: row.s3Key,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      role: 'original',
    });
    await tx
      .update(bundleImportItems)
      .set({
        stubDocumentId: docId,
        createdDocumentIds: [docId],
        // Файл дошёл до результата — исход больше не 'skipped'/'failed'.
        // Иначе он остался бы ещё и в блоке «дополнительные файлы»
        // собственной карточки (см. isExtraFileRow).
        status: 'created',
        effectiveStatus: 'created',
        reason: reasonText,
        updatedAt: new Date(),
      })
      .where(eq(bundleImportItems.id, row.id));

    return { action: 'created' as const, documentId: docId };
  });
}

/**
 * Строки реестра, по которым документа так и не появилось.
 *
 * Два отбора, потому что документ по файлу может висеть в ДРУГОМ месте:
 * накладные и кандидаты сборки router разворачивает в дочерний пакет, и
 * created_document_ids для этого пути не заполняется вовсе. Один запрос
 * «sub_bundle_id IS NULL» пропустил бы именно нераспознанные накладные.
 *
 * Строки с живым дочерним пакетом не трогаем: там работа ещё идёт.
 */
export async function selectRowsWithoutDocument(
  db: Db,
  opts: { bundleId?: string; olderThanMinutes?: number; limit?: number },
): Promise<Array<RegistryRow & { s3Key: string }>> {
  const age = opts.olderThanMinutes
    ? drSql`and bi.updated_at < now() - make_interval(mins => ${opts.olderThanMinutes})`
    : drSql``;
  const scope = opts.bundleId ? drSql`and bi.bundle_id = ${opts.bundleId}` : drSql``;
  const limit = opts.limit ?? 200;

  const rows = await db.execute<{
    id: string;
    bundle_id: string;
    input_s3_key: string;
    source_filename: string;
    mime_type: string | null;
    size_bytes: number | null;
    content_sha256: string | null;
    upload_generation: number | null;
    input_order: number | null;
    status: string;
    processing_mode: string;
    detected_kind: string | null;
    confidence: string | null;
    parser_used: string | null;
    created_document_ids: string[];
    reason: string | null;
    effective_status: string | null;
    sub_bundle_id: string | null;
    stub_document_id: string | null;
    resolved_at: Date | null;
    created_at: Date;
  }>(drSql`
    select bi.*
      from bundle_import_items bi
      join source_bundles b on b.id = bi.bundle_id
     where bi.input_s3_key is not null
       and bi.resolved_at is null
       and bi.stub_document_id is null
       -- Только живая загрузка: строки брошенных поколений в разбор не идут.
       and (bi.upload_generation = b.active_upload_generation or bi.upload_generation is null)
       and not exists (
         select 1
           from source_document_attachments a
           join source_documents d on d.id = a.source_document_id
          where a.s3_key = bi.input_s3_key and not d.is_technical
       )
       and (
         bi.sub_bundle_id is null
         or exists (
           -- Дочерний пакет завершился и ничего не создал: файл повис.
           select 1
             from source_bundles sb
            where sb.id = bi.sub_bundle_id
              and sb.status in ('parsed', 'parse_failed')
              and not exists (
                select 1 from source_documents sd
                 where sd.bundle_id = sb.id and not sd.is_technical
              )
         )
       )
       ${age}
       ${scope}
     order by bi.created_at
     limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    bundleId: r.bundle_id,
    s3Key: r.input_s3_key,
    filename: r.source_filename,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    contentSha256: r.content_sha256,
    uploadGeneration: r.upload_generation,
    inputOrder: r.input_order,
    status: r.status,
    processingMode: r.processing_mode,
    detectedKind: r.detected_kind,
    confidence: r.confidence,
    parserUsed: r.parser_used,
    createdDocumentIds: r.created_document_ids ?? [],
    reason: r.reason,
    effectiveStatus: r.effective_status,
    subBundleId: r.sub_bundle_id,
    stubDocumentId: r.stub_document_id,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  }));
}

/**
 * Почему по файлу нет документа — по тому, что реестр помнит о его разборе.
 *
 * store_only и supplementary — штатные исходы («так и задумано»), остальное —
 * технический сбой. Классификация только по строке реестра: она переживает и
 * разбор, и удаление служебной записи пакета.
 */
export function stubReasonForRow(row: Pick<RegistryRow, 'processingMode' | 'detectedKind'>): StubReason {
  if (row.processingMode === 'store_only') return 'supplementary';
  if (row.detectedKind === 'supplementary') return 'supplementary';
  if (row.detectedKind === 'transport_waybill' || row.detectedKind === 'os2_transfer') {
    return 'no_waybill_found';
  }
  if (row.detectedKind === 'unknown') return 'unrecognized_type';
  return 'not_processed';
}

/**
 * Закрывает строки реестра, документ по которым удалён.
 *
 * Без этого следующий же проход завёл бы заглушку заново — причём призраком:
 * удаление документа ставит его S3-ключи в очередь на физическое удаление.
 * resolved_at — существующий механизм «вопрос закрыт, не переоткрывать», им же
 * пользуется ручной разбор.
 */
export async function closeRegistryRowsForDeletedDocument(
  tx: Db,
  documentId: string,
  deletedByUserId: string | null,
): Promise<void> {
  await tx
    .update(bundleImportItems)
    .set({
      resolvedAt: new Date(),
      resolvedByUserId: deletedByUserId,
      reason: 'документ по файлу удалён',
      updatedAt: new Date(),
    })
    .where(
      and(
        isNull(bundleImportItems.resolvedAt),
        drSql`(${bundleImportItems.stubDocumentId} = ${documentId}
               or ${bundleImportItems.createdDocumentIds} @> ${JSON.stringify([documentId])}::jsonb)`,
      ),
    );
}
