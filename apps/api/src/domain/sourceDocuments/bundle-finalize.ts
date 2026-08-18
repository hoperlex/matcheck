// Перевод пакета в терминальное состояние — общий для воркера, сторожа и
// разовых скриптов.
//
// Живёт в domain, а не в worker.ts, по той же причине, что и реестр рядом
// (bundle-import-registry.ts): worker.ts — исполняемый модуль, на верхнем уровне
// он поднимает Queue, двух BullMQ-воркеров, обработчики сигналов и периодические
// задачи. Импорт его из stuck-jobs.ts или роута завёл бы второго воркера в чужом
// процессе.
//
// Зачем понадобилось. Router ставит пакету `processing`, если запустил сборку
// логических УПД, рассчитывая, что до терминала его доведёт публикация. Ветка
// ОТКАТА сборки этого не делала: она чинит дочерний пакет и разворачивает файлы
// обратно в документы, но статус корня не трогает вовсе. Пакет остаётся в
// `processing` навсегда — а `repairStuckJobs` ищет только `queued`, поэтому
// такой пакет не подбирает никто. На боевой БД так зависли 7 пакетов, и это
// ровно все откаты сборки: корреляция стопроцентная.
//
// Что функция НЕ делает — намеренно:
//   * не ставит заданий (ни queue.add, ни enqueueJob). Отсюда её главное
//     свойство: повторное распознавание она вызвать не может физически, сколько
//     бы раз её ни позвали;
//   * не воскрешает удалённое человеком — строки с resolved_at не трогает
//     finalizeStaleRegistryItems, а «живым» документ считается только по факту
//     существования строки в source_documents, а не по created_document_ids:
//     JSON переживает удаление документа и указывает в пустоту.

import { and, eq, isNull, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';
import { finalizeStaleRegistryItems } from './bundle-import-registry.js';

/** Статусы, из которых пакету уже никуда идти не нужно. */
const TERMINAL_BUNDLE_STATUSES = ['parsed', 'parse_failed'] as const;

export type FinalizeBundleResult = {
  /** Что произошло: пакет доведён до терминала или оставлен как был. */
  outcome: 'parsed' | 'parse_failed' | 'skipped';
  /** Почему пропустили (для лога). Пусто, если пакет финализирован. */
  skipReason?:
    | 'исчез'
    | 'уже терминальный'
    | 'поколение устарело'
    | 'опубликован'
    | 'статус изменился';
  /** Сколько живых нетехнических документов нашлось у пакета и его детей. */
  documents: number;
  /** Строки реестра, закрытые как несостоявшиеся. */
  finalizedItems: number;
};

export type FinalizeBundleOptions = {
  /** Dispatch-поколение пакетного задания, если финализация относится к конкретной попытке. */
  expectedDispatchGeneration?: number;
  /**
   * Не трогать пакет, поколение которого уже опубликовано.
   *
   * Нужно откату сборки: пока он разворачивает файлы, параллельная попытка
   * публикации могла успеть объявить поколение опубликованным, и отбирать у неё
   * статус нельзя.
   *
   * Работает только В ПАРЕ с `generation`: сравнение идёт с его номером.
   * Раньше здесь стояло `!== null`, то есть «пакет когда-либо публиковался», —
   * и пакет, у которого опубликовано ПРОШЛОЕ поколение, откатом уже не
   * закрывался и оставался в processing навсегда. Та же ошибка была в гейте
   * сборки и в loadSegmentContext.
   */
  requireUnpublished?: boolean;
  /**
   * Поколение, которое откатывается. Обязательно вместе с `requireUnpublished`:
   * без него условие никогда не совпадёт и защита от гонки с публикацией
   * перестанет работать.
   */
  generation?: number;
  /** Причина для строк реестра, не дошедших до разбора. */
  itemReason?: string;
  /**
   * Код и текст ошибки для перехода в parse_failed. Пишутся ТОЛЬКО если поле
   * пустое: у отката там уже лежит «сборка УПД отменена: …», и затирать
   * единственный след причины нельзя — llm_calls сегментов к этому моменту
   * удалены вместе с их документами.
   */
  parseErrorCode?: string;
  parseErrorMessage?: string;
};

/**
 * Доводит пакет до `parsed` / `parse_failed`.
 *
 * Итог выбирается по факту: есть хотя бы один живой нетехнический документ —
 * `parsed`, иначе `parse_failed`. `parsed` здесь означает ровно то же, что у
 * штатного router-job: файлы разложены по документам и задания поставлены, —
 * а не «распознавание закончено».
 *
 * Всё в одной транзакции с `FOR UPDATE` по строке пакета: между проверкой
 * «документы есть» и записью статуса не должно вклиниться завершение
 * параллельного задания.
 */
export async function finalizeBundleTerminalState(
  db: Db,
  bundleId: string,
  opts: FinalizeBundleOptions = {},
): Promise<FinalizeBundleResult> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;

    const [bundle] = await tx
      .select({
        id: sourceBundles.id,
        status: sourceBundles.status,
        publishedGeneration: sourceBundles.publishedGeneration,
        parseErrorCode: sourceBundles.parseErrorCode,
        dispatchGeneration: sourceBundles.dispatchGeneration,
        parseErrorMessage: sourceBundles.parseErrorMessage,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, bundleId))
      .for('update');

    if (!bundle) {
      return {
        outcome: 'skipped' as const,
        skipReason: 'исчез' as const,
        documents: 0,
        finalizedItems: 0,
      };
    }
    if (
      opts.expectedDispatchGeneration !== undefined &&
      bundle.dispatchGeneration !== opts.expectedDispatchGeneration
    ) {
      return {
        outcome: 'skipped' as const,
        skipReason: 'поколение устарело' as const,
        documents: 0,
        finalizedItems: 0,
      };
    }
    if ((TERMINAL_BUNDLE_STATUSES as readonly string[]).includes(bundle.status)) {
      return {
        outcome: 'skipped' as const,
        skipReason: 'уже терминальный' as const,
        documents: 0,
        finalizedItems: 0,
      };
    }
    // Сравнение строго с номером поколения. Ветки «а если поколение не
    // передали» здесь намеренно нет: она вырождалась бы в прежнее «пакет
    // когда-либо публиковался» — ту самую ошибку, из-за которой повторно
    // загруженный комплект оставался в processing.
    if (opts.requireUnpublished && bundle.publishedGeneration === opts.generation) {
      return {
        outcome: 'skipped' as const,
        skipReason: 'опубликован' as const,
        documents: 0,
        finalizedItems: 0,
      };
    }

    // Строки, не назвавшие исход, закрываем ДО подсчёта документов: иначе файл,
    // застрявший в accepted, не виден ни в «Документах», ни как дополнительный.
    const finalized = await finalizeStaleRegistryItems(scoped, bundleId, {
      reason: opts.itemReason ?? 'файл не дошёл до разбора (пакет закрыт без него)',
    });

    // Живой документ ищем и на самом пакете, и в дочерних: накладные router
    // разворачивает отдельным пакетом, и реальный документ висит уже на нём.
    const [counted] = await tx
      .select({ n: drSql<number>`count(*)::int` })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.isTechnical, false),
          drSql`(${sourceDocuments.bundleId} = ${bundleId} or ${sourceDocuments.bundleId} in (
                  select c.id from source_bundles c where c.parent_bundle_id = ${bundleId}
                ))`,
        ),
      );
    const documents = counted?.n ?? 0;
    const nextStatus = documents > 0 ? 'parsed' : 'parse_failed';

    const updated = await tx
      .update(sourceBundles)
      .set({
        status: nextStatus,
        ...(nextStatus === 'parse_failed' && !bundle.parseErrorCode && opts.parseErrorCode
          ? { parseErrorCode: opts.parseErrorCode }
          : {}),
        ...(nextStatus === 'parse_failed' && !bundle.parseErrorMessage && opts.parseErrorMessage
          ? { parseErrorMessage: opts.parseErrorMessage.slice(0, 500) }
          : {}),
        updatedAt: new Date(),
      })
      // CAS поверх FOR UPDATE: блокировка уже сериализовала запись, условие —
      // страховка от того, что кто-то обновит статус в обход блокировки.
      .where(and(eq(sourceBundles.id, bundleId), eq(sourceBundles.status, bundle.status)))
      .returning({ id: sourceBundles.id });

    if (updated.length === 0) {
      return {
        outcome: 'skipped' as const,
        skipReason: 'статус изменился' as const,
        documents,
        finalizedItems: finalized.length,
      };
    }

    return { outcome: nextStatus, documents, finalizedItems: finalized.length };
  });
}

/**
 * Пакеты, зависшие в нетерминальном статусе, у которых работа заведомо
 * закончилась.
 *
 * Каждое условие отсекает «разбор ещё идёт», и любое сомнение трактуется в
 * пользу бездействия: лучше оставить пакет висеть ещё десять минут, чем объявить
 * исход у того, что прямо сейчас распознаётся.
 *
 * Отдельная выборка, а не selectBundlesWithStaleItems: та ищет пакеты уже
 * ТЕРМИНАЛЬНЫЕ, у которых остались незакрытые строки реестра, — обратный случай.
 */
export async function selectStuckProcessingBundles(
  db: Db,
  cutoffMinutes: number,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: sourceBundles.id })
    .from(sourceBundles)
    .where(
      and(
        eq(sourceBundles.status, 'processing'),
        // Дочерние пакеты закрывает их родитель, у них своя механика.
        isNull(sourceBundles.parentBundleId),
        drSql`${sourceBundles.updatedAt} < now() - make_interval(mins => ${cutoffMinutes})`,
        // Сборка ещё идёт: есть неопубликованный сегмент активного поколения.
        drSql`not exists (
          select 1 from bundle_segments s
           where s.bundle_id = ${sourceBundles.id}
             and s.generation = ${sourceBundles.activeUploadGeneration}
             and s.published_at is null
        )`,
        // Дочерний пакет в работе — родителя не трогаем.
        drSql`not exists (
          select 1 from source_bundles c
           where c.parent_bundle_id = ${sourceBundles.id}
             and c.status in ('queued', 'processing')
        )`,
        // Жива техническая запись — значит router-job не доработал. Это другой
        // случай: его надо перезапускать, а не объявлять исход.
        drSql`not exists (
          select 1 from source_documents d
           where d.bundle_id = ${sourceBundles.id} and d.is_technical = true
        )`,
        // Есть недоставленное задание по этому пакету — работа впереди.
        drSql`not exists (
          select 1 from job_outbox o where o.payload->>'bundleId' = ${sourceBundles.id}::text
        )`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}
