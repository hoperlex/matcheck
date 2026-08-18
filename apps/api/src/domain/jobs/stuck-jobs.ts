// Периодическое восстановление незавершённой работы распознавания.
//
// Решение о восстановлении принимается не только по возрасту строки: сторож
// сверяет transactional outbox и BullMQ. Живая работа не трогается, недоступный
// Redis даёт unknown, а потерянная/просроченная попытка получает новое поколение
// и новый jobId. Предыдущее поколение после этого не может записать результат:
// обработчики проверяют generation под блокировкой перед видимыми изменениями.
//
// Порог намеренно большой: воркер разбирает пачки последовательно
// (CONCURRENCY=1) и при длинной очереди запись законно ждёт десятки минут.

import { and, eq, inArray, isNotNull, isNull, lt, sql as drSql } from 'drizzle-orm';
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
  dispatchKeyOf,
  documentSecondPassKeyOf,
} from './job-outbox.js';
import { inspectWorkHealth, type WorkHealthQueue } from './job-health.js';
import { recoverDocumentAttempt } from './recognition-recovery.js';
import { recoverBundleAttempt, recoverSegmentAttempt } from './recognition-attempt-recovery.js';
import {
  finalizeStaleRegistryItems,
  selectBundlesWithStaleItems,
} from '../sourceDocuments/bundle-import-registry.js';
import {
  ensureDocumentForRegistryRow,
  selectRowsWithoutDocument,
  stubReasonForRow,
} from '../sourceDocuments/stub-documents.js';
import {
  finalizeBundleTerminalState,
  selectStuckProcessingBundles,
} from '../sourceDocuments/bundle-finalize.js';

/** Сколько запись должна провисеть в `queued`, чтобы считаться потерянной. */
export const STUCK_AFTER_MINUTES = 45;

/** Максимум записей за один прогон — repair не должен заваливать очередь. */
export const STUCK_BATCH = 20;

export const STUCK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Режим восстановления — см. RECOGNITION_RECOVERY_MODE в env.ts.
 *
 * `dry_run` существует не ради осторожности вообще, а ради одного конкретного
 * вопроса: сторож принимает решения по неполным данным (Redis, outbox, БД), и
 * ошибка в классификации живого как мёртвого означала бы второй разбор поверх
 * идущего. Список «что я сделал бы» в логе — единственный способ проверить это
 * до того, как он начнёт переставлять работу на боевом сервере.
 */
export type RecoveryMode = 'off' | 'dry_run' | 'on';

export type RepairDeps = {
  db: Db;
  queue: string;
  log?: { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };
  queueClient: WorkHealthQueue;
  /**
   * По умолчанию `off`: выкат кода и включение механизма — разные события.
   * Между ними обязан пройти деплой ВСЕХ воркеров, иначе старый воркер, не
   * знающий про поколения, запишет результат поверх восстановленного.
   */
  mode?: RecoveryMode;
};

export type RepairResult = {
  documents: number;
  terminalizedDocuments: number;
  /** Записи, которые сторож переставил бы при mode='on'. Только для dry_run. */
  wouldRecover: number;
  bundles: number;
  /** Сегменты сборки логических УПД, переставленные заново. */
  segments: number;
  finalizedItems: number;
  /** Принятые файлы, оставшиеся без документа: заведены заглушки. */
  stubbedFiles: number;
  /** Пакеты, зависшие в `processing`: работа закончилась, статус досинхронизирован. */
  finalizedBundles: number;
  /** Пакеты, у которых router-job умер посреди пачки: задание поставлено заново. */
  restartedBundles: number;
};

/**
 * Переставляет задания для записей, зависших в `queued`.
 *
 * Возвращает, сколько заданий поставлено заново. Ничего не найдено — тихо
 * возвращает нули, без логов: функция вызывается по таймеру.
 */
export async function repairStuckJobs(deps: RepairDeps): Promise<RepairResult> {
  const { db } = deps;
  const mode = deps.mode ?? 'off';
  const cutoff = drSql`now() - make_interval(mins => ${STUCK_AFTER_MINUTES})`;
  // Счётчик dry-run общий на три контура: он отвечает на один вопрос — сколько
  // записей сторож тронул бы, если его включить.
  let wouldRecover = 0;

  // ─── Документы: ждут одиночного разбора ──────────────────────────────────
  //
  // Берём только те, у которых есть оригинальный файл: без него распознавать
  // нечего, и повторная постановка задания ничего не изменит.
  const docs =
    mode === 'off'
      ? []
      : await db
          .select({
            id: sourceDocuments.id,
            s3Key: sourceDocumentAttachments.s3Key,
            kind: sourceDocuments.kind,
            parseMode: sourceDocuments.parseMode,
            dispatchGeneration: sourceDocuments.dispatchGeneration,
            secondPass: sourceDocuments.secondPass,
            jobId: sourceDocuments.jobId,
          })
          .from(sourceDocuments)
          .innerJoin(
            sourceDocumentAttachments,
            eq(sourceDocumentAttachments.sourceDocumentId, sourceDocuments.id),
          )
          .where(
            and(
              inArray(sourceDocuments.status, ['queued', 'processing']),
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
  let terminalizedDocuments = 0;
  for (const doc of docs) {
    // У документа может быть несколько вложений — задание нужно одно.
    if (seenDocs.has(doc.id)) continue;
    seenDocs.add(doc.id);
    const pendingSecondPass = (doc.secondPass as { state?: string } | null)?.state === 'queued';
    const currentJobId =
      doc.jobId ??
      (pendingSecondPass
        ? documentSecondPassKeyOf(doc.id, doc.dispatchGeneration)
        : dispatchKeyOf(doc.id, doc.dispatchGeneration));
    const health = await inspectWorkHealth({
      db,
      queue: deps.queueClient,
      jobId: currentJobId,
    });
    if (health.state === 'alive' || health.state === 'alive_transport') {
      continue;
    }
    if (health.state === 'unknown') {
      deps.log?.warn?.(
        { sourceDocumentId: doc.id, err: health.reason },
        'repair: состояние задания неизвестно — recovery пропущен',
      );
      continue;
    }
    if (mode === 'dry_run') {
      wouldRecover += 1;
      deps.log?.warn?.(
        { sourceDocumentId: doc.id, health: health.state, jobId: currentJobId },
        'repair(dry-run): документ был бы переставлен',
      );
      continue;
    }
    const outcome = await recoverDocumentAttempt({
      db,
      queueName: deps.queue,
      sourceDocumentId: doc.id,
      expectedGeneration: doc.dispatchGeneration,
      health,
      actor: 'watchdog',
    });
    if (outcome.outcome === 'recovered') documents += 1;
    if (outcome.outcome === 'terminalized') terminalizedDocuments += 1;
  }

  // ─── Сегменты сборки: технические документы, ждущие своего распознавания ──
  //
  // Общая выборка выше берёт только is_technical = false, и это правильно:
  // служебные записи пакетов ждут задания ПАКЕТА. Но документ сегмента —
  // исключение: он технический ровно до публикации, а задание у него своё,
  // адресующее строку манифеста. Без этой ветки зависший сегмент не
  // восстановился бы никогда, и комплект не опубликовался бы вовсе.
  const staleSegments =
    mode === 'off'
      ? []
      : await db
          .select({
            docId: bundleSegments.sourceDocumentId,
            segmentId: bundleSegments.id,
            generation: bundleSegments.generation,
            dispatchGeneration: bundleSegments.dispatchGeneration,
            docGeneration: sourceDocuments.dispatchGeneration,
            jobId: sourceDocuments.jobId,
          })
          .from(bundleSegments)
          .innerJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
          .where(
            and(
              inArray(sourceDocuments.status, ['queued', 'processing']),
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
    const health = await inspectWorkHealth({
      db,
      queue: deps.queueClient,
      jobId: seg.jobId,
    });
    if (health.state === 'alive' || health.state === 'alive_transport') continue;
    if (health.state === 'unknown') {
      deps.log?.warn?.(
        { segmentId: seg.segmentId, err: health.reason },
        'repair: состояние задания сегмента неизвестно — recovery пропущен',
      );
      continue;
    }
    if (mode === 'dry_run') {
      wouldRecover += 1;
      deps.log?.warn?.(
        { segmentId: seg.segmentId, health: health.state, jobId: seg.jobId },
        'repair(dry-run): сегмент был бы переставлен',
      );
      continue;
    }
    const outcome = await recoverSegmentAttempt({
      db,
      queueName: deps.queue,
      segmentId: seg.segmentId,
      sourceDocumentId: seg.docId,
      expectedGeneration: seg.dispatchGeneration,
      expectedDocGeneration: seg.docGeneration,
      health,
      actor: 'watchdog',
    });
    if (outcome.outcome === 'recovered') segments += 1;
    if (outcome.outcome === 'terminalized') terminalizedDocuments += 1;
  }

  // ─── Пакеты: ждут разбора router'ом или waybill-парсером ─────────────────
  //
  // Только те, где разбор заведомо не начинался: служебная запись на месте,
  // реальных документов нет. Пакет с уже созданными документами повторять
  // нельзя — получим их вторые экземпляры.
  const bundles =
    mode === 'off'
      ? []
      : await db
          .select({
            id: sourceBundles.id,
            kind: sourceBundles.kind,
            parentBundleId: sourceBundles.parentBundleId,
            generation: sourceBundles.dispatchGeneration,
            activeUploadGeneration: sourceBundles.activeUploadGeneration,
            jobId: sourceBundles.jobId,
          })
          .from(sourceBundles)
          .where(
            and(
              inArray(sourceBundles.status, ['queued', 'processing']),
              lt(sourceBundles.updatedAt, cutoff),
              drSql`exists (select 1 from source_documents d
                where d.bundle_id = ${sourceBundles.id} and d.is_technical = true)`,
            ),
          )
          .limit(STUCK_BATCH);

  let repairedBundles = 0;
  for (const bundle of bundles) {
    let currentJobId = bundle.jobId;
    if (!currentJobId && bundle.kind === 'upd' && bundle.parentBundleId) {
      currentJobId = assemblyDispatchKeyOf(bundle.id, bundle.generation);
    } else if (!currentJobId) {
      currentJobId = bundleDispatchKeyOf(bundle.id, bundle.generation);
    }
    const health = await inspectWorkHealth({
      db,
      queue: deps.queueClient,
      jobId: currentJobId,
    });
    if (health.state === 'alive' || health.state === 'alive_transport') continue;
    if (health.state === 'unknown') {
      deps.log?.warn?.(
        { bundleId: bundle.id, err: health.reason },
        'repair: состояние пакетного задания неизвестно — recovery пропущен',
      );
      continue;
    }
    if (mode === 'dry_run') {
      wouldRecover += 1;
      deps.log?.warn?.(
        { bundleId: bundle.id, health: health.state, jobId: currentJobId },
        'repair(dry-run): пакет был бы переставлен',
      );
      continue;
    }
    const outcome = await recoverBundleAttempt({
      db,
      queueName: deps.queue,
      bundleId: bundle.id,
      expectedGeneration: bundle.generation,
      health,
      actor: 'watchdog',
    });
    if (outcome.outcome === 'recovered') repairedBundles += 1;
    if (outcome.outcome === 'terminalized') terminalizedDocuments += 1;
  }

  if (documents || repairedBundles || segments) {
    deps.log?.warn?.(
      { documents, bundles: repairedBundles, segments, thresholdMin: STUCK_AFTER_MINUTES },
      'repair: найдены записи без задания, поставлены заново',
    );
  }

  const finalizedItems = await finalizeIncompleteBundles(deps);
  const stubbedFiles = await ensureDocumentsForOrphanFiles(deps);
  // Processing-пакеты уже проходят через health-aware контур выше.
  const restartedBundles = 0;
  const finalizedBundles = await finalizeStuckProcessingBundles(deps);
  if (wouldRecover) {
    deps.log?.warn?.(
      { wouldRecover, thresholdMin: STUCK_AFTER_MINUTES },
      'repair(dry-run): записи без актуального задания найдены, ничего не изменено',
    );
  }

  return {
    documents,
    bundles: repairedBundles,
    terminalizedDocuments,
    wouldRecover,
    segments,
    finalizedItems,
    stubbedFiles,
    finalizedBundles,
    restartedBundles,
  };
}

/**
 * Пакет застрял в `processing`, а работать по нему уже некому.
 *
 * Router ставит `processing` при запуске сборки логических УПД, рассчитывая, что
 * до терминала пакет доведёт публикация. Ветка ОТКАТА сборки этого не делала —
 * пакет висел вечно, потому что основной repair ищет только `queued`. По бою так
 * зависли 7 пакетов, ровно все откаты сборки; A1 закрыл сам источник, эта
 * функция подбирает уже зависшие и всё, что зависнет иным путём (например крах
 * между разбором и записью статуса).
 *
 * Заданий не ставит вовсе — только досинхронизирует статус, поэтому повторного
 * распознавания вызвать не может. Условия отбора живут в
 * selectStuckProcessingBundles и трактуют любое сомнение в пользу бездействия.
 */
export async function finalizeStuckProcessingBundles(deps: RepairDeps): Promise<number> {
  const ids = await selectStuckProcessingBundles(deps.db, STUCK_AFTER_MINUTES, STUCK_BATCH);
  let finalized = 0;
  for (const id of ids) {
    const [bundle] = await deps.db
      .select({
        dispatchGeneration: sourceBundles.dispatchGeneration,
        jobId: sourceBundles.jobId,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, id))
      .limit(1);
    if (!bundle) continue;

    const health = await inspectWorkHealth({
      db: deps.db,
      queue: deps.queueClient,
      jobId: bundle.jobId ?? bundleDispatchKeyOf(id, bundle.dispatchGeneration),
    });
    if (health.state === 'alive' || health.state === 'alive_transport') continue;
    if (health.state === 'unknown') {
      deps.log?.warn?.(
        { bundleId: id, err: health.reason },
        'repair: состояние processing-пакета неизвестно — финализация пропущена',
      );
      continue;
    }

    const res = await finalizeBundleTerminalState(deps.db, id, {
      expectedDispatchGeneration: bundle.dispatchGeneration,
      itemReason: 'файл не дошёл до разбора (пакет закрыт сторожем)',
      parseErrorCode: 'not_finalized',
      parseErrorMessage: 'пакет остался в processing без активной работы',
    });
    if (res.outcome === 'skipped') continue;
    finalized += 1;
    deps.log?.warn?.(
      { bundleId: id, outcome: res.outcome, documents: res.documents },
      'repair: пакет висел в processing без работы — статус досинхронизирован',
    );
  }
  return finalized;
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
          {
            bundleId: row.bundleId,
            file: row.filename,
            documentId: res.documentId,
            how: res.action,
          },
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
