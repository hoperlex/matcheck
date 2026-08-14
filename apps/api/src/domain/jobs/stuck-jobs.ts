// Восстановление записей, застрявших в `queued` без задания.
//
// Зачем. Даже с transactional outbox остаётся окно, где запись есть, а задания
// нет: строка outbox доставлена и удалена, но воркер упал до перевода записи в
// `processing`; или задание выполнилось, а обновление статуса не дошло. Такая
// запись висит `queued` вечно — повторная загрузка того же комплекта вернёт
// «уже загружено» и нового задания не поставит.
//
// Почему это безопасно и не приводит к двойному распознаванию:
//
//   * ключ задания тот же, что при первой постановке (`dispatchKeyOf`), а
//     BullMQ не создаёт второй job с существующим jobId — пока задание висит в
//     очереди или выполняется, repair его не продублирует;
//   * `enqueueJob` дедуплицирует по тому же ключу, поэтому повтор repair'а не
//     плодит строк outbox;
//   * повторный разбор документа идемпотентен по позициям: обработчик удаляет
//     старые строки перед вставкой новых;
//   * пакет берётся только если разбор ещё не начинался — есть служебная
//     запись и НЕТ ни одного реального документа. Иначе повтор создал бы
//     вторые экземпляры уже разобранных документов.
//
// Порог намеренно большой: воркер разбирает пачки последовательно
// (CONCURRENCY=1) и при длинной очереди запись законно ждёт десятки минут.

import { and, eq, isNotNull, isNull, lt, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  bundleSegments,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import {
  assemblyDispatchKeyOf,
  bundleDispatchKeyOf,
  documentSecondPassKeyOf,
  enqueueJob,
  segmentDispatchKeyOf,
} from './job-outbox.js';
import { isBlocked, resolveReparsePlan } from '../sourceDocuments/reparse-plan.js';
import {
  finalizeStaleRegistryItems,
  selectBundlesWithStaleItems,
} from '../sourceDocuments/bundle-import-registry.js';
import {
  ensureDocumentForRegistryRow,
  selectRowsWithoutDocument,
  stubReasonForRow,
} from '../sourceDocuments/stub-documents.js';

/** Сколько запись должна провисеть в `queued`, чтобы считаться потерянной. */
export const STUCK_AFTER_MINUTES = 45;

/** Максимум записей за один прогон — repair не должен заваливать очередь. */
export const STUCK_BATCH = 20;

export const STUCK_INTERVAL_MS = 10 * 60 * 1000;

export type RepairDeps = {
  db: Db;
  queue: string;
  log?: { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };
};

export type RepairResult = {
  documents: number;
  bundles: number;
  /** Сегменты сборки логических УПД, переставленные заново. */
  segments: number;
  finalizedItems: number;
  /** Принятые файлы, оставшиеся без документа: заведены заглушки. */
  stubbedFiles: number;
};

/**
 * Переставляет задания для записей, зависших в `queued`.
 *
 * Возвращает, сколько заданий поставлено заново. Ничего не найдено — тихо
 * возвращает нули, без логов: функция вызывается по таймеру.
 */
export async function repairStuckJobs(deps: RepairDeps): Promise<RepairResult> {
  const { db } = deps;
  const cutoff = drSql`now() - make_interval(mins => ${STUCK_AFTER_MINUTES})`;

  // ─── Документы: ждут одиночного разбора ──────────────────────────────────
  //
  // Берём только те, у которых есть оригинальный файл: без него распознавать
  // нечего, и повторная постановка задания ничего не изменит.
  const docs = await db
    .select({
      id: sourceDocuments.id,
      s3Key: sourceDocumentAttachments.s3Key,
      kind: sourceDocuments.kind,
      parseMode: sourceDocuments.parseMode,
      dispatchGeneration: sourceDocuments.dispatchGeneration,
      secondPass: sourceDocuments.secondPass,
    })
    .from(sourceDocuments)
    .innerJoin(
      sourceDocumentAttachments,
      eq(sourceDocumentAttachments.sourceDocumentId, sourceDocuments.id),
    )
    .where(
      and(
        eq(sourceDocuments.status, 'queued'),
        // Служебные записи ждут задания ПАКЕТА — их обрабатывает вторая часть.
        eq(sourceDocuments.isTechnical, false),
        eq(sourceDocumentAttachments.role, 'original'),
        isNotNull(sourceDocuments.queuedAt),
        lt(sourceDocuments.queuedAt, cutoff),
      ),
    )
    .limit(STUCK_BATCH);

  let documents = 0;
  const seenDocs = new Set<string>();
  for (const doc of docs) {
    // У документа может быть несколько вложений — задание нужно одно.
    if (seenDocs.has(doc.id)) continue;
    seenDocs.add(doc.id);
    // Незавершённый второй проход восстанавливаем именно как второй проход.
    // Обычное задание здесь вернуло бы документ на текстовый путь — тот самый,
    // который уже дал слабый результат и породил повтор.
    const pendingSecondPass =
      (doc.secondPass as { state?: string } | null)?.state === 'queued';
    if (pendingSecondPass) {
      await enqueueJob(db, {
        queue: deps.queue,
        jobName: 'parse',
        payload: {
          sourceDocumentId: doc.id,
          s3Key: doc.s3Key,
          pass: 'vision' as const,
          docGeneration: doc.dispatchGeneration,
        },
        // Ключ версионный: после ручного повтора старый уже отработал, а BullMQ
        // держит завершённые задания сутки — иначе задание молча не создалось бы.
        dedupeKey: documentSecondPassKeyOf(doc.id, doc.dispatchGeneration),
      });
      documents += 1;
      continue;
    }

    // Остальное строит общий планировщик — тот же, которым пользуется кнопка
    // «Распознать повторно». Раньше здесь всегда ставилось задание по s3Key без
    // docKind, и зависшая М-15 восстанавливалась УПД-путём: другой промпт,
    // другой результат. Он же выбирает ключ: у ручного повтора своё поколение.
    const plan = await resolveReparsePlan(db, doc, doc.dispatchGeneration);
    if (isBlocked(plan)) continue;
    await enqueueJob(db, {
      queue: deps.queue,
      jobName: 'parse',
      payload: plan.payload,
      dedupeKey: plan.dedupeKey,
    });
    documents += 1;
  }

  // ─── Сегменты сборки: технические документы, ждущие своего распознавания ──
  //
  // Общая выборка выше берёт только is_technical = false, и это правильно:
  // служебные записи пакетов ждут задания ПАКЕТА. Но документ сегмента —
  // исключение: он технический ровно до публикации, а задание у него своё,
  // адресующее строку манифеста. Без этой ветки зависший сегмент не
  // восстановился бы никогда, и комплект не опубликовался бы вовсе.
  const staleSegments = await db
    .select({
      docId: bundleSegments.sourceDocumentId,
      segmentId: bundleSegments.id,
      generation: bundleSegments.generation,
    })
    .from(bundleSegments)
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
    .where(
      and(
        eq(sourceDocuments.status, 'queued'),
        eq(sourceDocuments.isTechnical, true),
        isNull(bundleSegments.publishedAt),
        isNotNull(sourceDocuments.queuedAt),
        lt(sourceDocuments.queuedAt, cutoff),
      ),
    )
    .limit(STUCK_BATCH);

  let segments = 0;
  for (const seg of staleSegments) {
    if (!seg.docId) continue;
    await enqueueJob(db, {
      queue: deps.queue,
      jobName: 'parse',
      // Payload и ключ ровно те же, что при первой постановке: иначе BullMQ
      // примет задание за новое и сегмент распознается дважды.
      payload: { sourceDocumentId: seg.docId, segmentId: seg.segmentId, generation: seg.generation },
      dedupeKey: segmentDispatchKeyOf(seg.segmentId, seg.generation),
    });
    segments += 1;
  }

  // ─── Пакеты: ждут разбора router'ом или waybill-парсером ─────────────────
  //
  // Только те, где разбор заведомо не начинался: служебная запись на месте,
  // реальных документов нет. Пакет с уже созданными документами повторять
  // нельзя — получим их вторые экземпляры.
  const bundles = await db
    .select({
      id: sourceBundles.id,
      kind: sourceBundles.kind,
      parentBundleId: sourceBundles.parentBundleId,
      generation: sourceBundles.dispatchGeneration,
    })
    .from(sourceBundles)
    .where(
      and(
        eq(sourceBundles.status, 'queued'),
        lt(sourceBundles.updatedAt, cutoff),
        drSql`exists (select 1 from source_documents d
                where d.bundle_id = ${sourceBundles.id} and d.is_technical = true)`,
        drSql`not exists (select 1 from source_documents d
                where d.bundle_id = ${sourceBundles.id} and d.is_technical = false)`,
      ),
    )
    .limit(STUCK_BATCH);

  let repairedBundles = 0;
  for (const bundle of bundles) {
    // Router-пакеты (kind='mixed') приходят из единого входа и требуют
    // mode:'router'; накладные разбираются waybill-веткой. Дочерний пакет
    // сборки (kind='upd' с родителем) — третий случай: без своего режима он
    // ушёл бы в waybill-обработчик, не нашёл там накладных и пометил бы пакет
    // parse_failed, потеряв уже загруженные файлы.
    if (bundle.kind === 'upd' && bundle.parentBundleId) {
      const [root] = await db
        .select({ gen: sourceBundles.activeUploadGeneration })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, bundle.parentBundleId))
        .limit(1);
      if (!root) continue;
      await enqueueJob(db, {
        queue: deps.queue,
        jobName: 'parse',
        payload: { bundleId: bundle.id, mode: 'upd_assembly' as const, generation: root.gen },
        dedupeKey: assemblyDispatchKeyOf(bundle.id, root.gen),
      });
      repairedBundles += 1;
      continue;
    }
    const payload =
      bundle.kind === 'mixed'
        ? { bundleId: bundle.id, mode: 'router' as const }
        : { bundleId: bundle.id };
    await enqueueJob(db, {
      queue: deps.queue,
      jobName: 'parse',
      payload,
      dedupeKey: bundleDispatchKeyOf(bundle.id, bundle.generation),
    });
    repairedBundles += 1;
  }

  if (documents || repairedBundles || segments) {
    deps.log?.warn?.(
      { documents, bundles: repairedBundles, segments, thresholdMin: STUCK_AFTER_MINUTES },
      'repair: найдены записи без задания, поставлены заново',
    );
  }

  const finalizedItems = await finalizeIncompleteBundles(deps);
  const stubbedFiles = await ensureDocumentsForOrphanFiles(deps);
  return { documents, bundles: repairedBundles, segments, finalizedItems, stubbedFiles };
}

/**
 * Страховка инварианта видимости: принятый файл остался без документа.
 *
 * Штатно заглушку заводит сам router-job, но между разбором и записью есть
 * окно, а дочерний пакет накладной мог умереть молча — тогда файл лежит в S3, а
 * менеджер видит «ничего не пришло».
 *
 * Отбор внутри (selectRowsWithoutDocument) делится надвое: обычные строки и
 * строки, чей дочерний пакет завершился без документов. Одним условием их не
 * покрыть — у файлов, уехавших в дочерний пакет, документ висит не на строке
 * реестра, и created_document_ids для этого пути не заполняется вовсе.
 *
 * Закрытые человеком (resolved_at) не трогаем: там же лежит и удаление
 * документа — воскрешать его нельзя, S3-объекта за ним уже нет.
 */
export async function ensureDocumentsForOrphanFiles(deps: RepairDeps): Promise<number> {
  const rows = await selectRowsWithoutDocument(deps.db, {
    olderThanMinutes: STUCK_AFTER_MINUTES,
    limit: STUCK_BATCH,
  });
  let stubbed = 0;
  for (const row of rows) {
    const [bundle] = await deps.db
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.id, row.bundleId))
      .limit(1);
    if (!bundle) continue;
    try {
      const res = await ensureDocumentForRegistryRow({
        db: deps.db,
        row,
        bundle,
        reason: stubReasonForRow(row),
      });
      if (res.action === 'created' || res.action === 'promoted') {
        stubbed += 1;
        deps.log?.warn?.(
          { bundleId: row.bundleId, file: row.filename, documentId: res.documentId, how: res.action },
          'repair: принятый файл остался без документа — теперь виден',
        );
      } else if (res.action === 'missing_object') {
        deps.log?.warn?.(
          { bundleId: row.bundleId, file: row.filename },
          'repair: файла нет в хранилище — документ не заводим',
        );
      }
    } catch (err) {
      // Сетевая ошибка S3 или гонка: следующий прогон повторит.
      deps.log?.warn?.({ err, file: row.filename }, 'repair: заглушку завести не удалось');
    }
  }
  return stubbed;
}

/**
 * Страховка инварианта завершённости: пакет уже помечен разобранным (или
 * упавшим), а в реестре остались строки «в процессе».
 *
 * Штатно их закрывает сам router-job, но между обновлением строк и пакета есть
 * окно: крах в нём оставляет файл невидимым — документа нет, а в дополнительные
 * файлы он не попадает. Порог тот же, что у repair: раньше строка законно может
 * быть в работе.
 */
export async function finalizeIncompleteBundles(deps: RepairDeps): Promise<number> {
  const bundleIds = await selectBundlesWithStaleItems(deps.db, STUCK_AFTER_MINUTES, STUCK_BATCH);
  let finalized = 0;
  for (const bundleId of bundleIds) {
    const rows = await finalizeStaleRegistryItems(deps.db, bundleId, {
      reason: 'файл не дошёл до разбора (пакет закрыт без него)',
    });
    finalized += rows.length;
    if (rows.length > 0) {
      deps.log?.warn?.(
        { bundleId, files: rows.map((r) => r.filename) },
        'repair: у закрытого пакета остались незавершённые файлы — помечены failed',
      );
    }
  }
  return finalized;
}
