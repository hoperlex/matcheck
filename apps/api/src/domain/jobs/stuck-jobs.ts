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

import { and, eq, isNotNull, lt, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import {
  bundleDispatchKeyOf,
  dispatchKeyOf,
  documentSecondPassKeyOf,
  enqueueJob,
} from './job-outbox.js';
import {
  finalizeStaleRegistryItems,
  selectBundlesWithStaleItems,
} from '../sourceDocuments/bundle-import-registry.js';

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

export type RepairResult = { documents: number; bundles: number; finalizedItems: number };

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
    await enqueueJob(db, {
      queue: deps.queue,
      jobName: 'parse',
      payload: pendingSecondPass
        ? { sourceDocumentId: doc.id, s3Key: doc.s3Key, pass: 'vision' as const }
        : { sourceDocumentId: doc.id, s3Key: doc.s3Key },
      dedupeKey: pendingSecondPass ? documentSecondPassKeyOf(doc.id) : dispatchKeyOf(doc.id),
    });
    documents += 1;
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
    // mode:'router'; накладные разбираются waybill-веткой.
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

  if (documents || repairedBundles) {
    deps.log?.warn?.(
      { documents, bundles: repairedBundles, thresholdMin: STUCK_AFTER_MINUTES },
      'repair: найдены записи без задания, поставлены заново',
    );
  }

  const finalizedItems = await finalizeIncompleteBundles(deps);
  return { documents, bundles: repairedBundles, finalizedItems };
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
