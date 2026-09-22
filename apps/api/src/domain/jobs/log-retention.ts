import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/**
 * Ретенция служебных журналов распознавания.
 *
 * Зачем. `llm_calls` прибавляет около 17 тысяч записей и 58 МБ в месяц, и
 * чистки у него не было ни одной: таблица живёт с июня, и за год она обогнала
 * бы по размеру всю остальную базу. Основной вес — не ответы модели, а копия
 * фрагмента промпта, которая пишется в каждую запись.
 *
 * Почему улики нельзя чистить так же смело, как журнал вызовов. Запись
 * `page_classification` — не только диагностика: по ней считается откат сборки
 * (`rollbackKindsByFile`) и аудит потерянных страниц при публикации комплекта.
 * Оба чтения происходят в пределах одной обработки пакета, но опираться на
 * «это же просто лог» нельзя. Поэтому возраст — не единственное условие:
 * улики пакета, который ещё не дошёл до терминального состояния, не удаляются
 * НИКОГДА, независимо от того, сколько им дней.
 *
 * Удаление идёт батчами: длинный DELETE держал бы блокировку и мешал разбору,
 * а первый прогон на накопленной истории иначе создал бы заметный всплеск
 * мёртвых строк и WAL разом.
 */

/** Сколько строк удаляем за один DELETE. */
export const RETENTION_BATCH_SIZE = 2000;

/**
 * Потолок батчей за прогон. При суточном интервале 25 × 2000 = 50 000 строк в
 * день — больше, чем система производит (~17 тыс. в месяц), поэтому отставание
 * рассосётся за несколько прогонов, а разовой нагрузки не будет.
 */
export const RETENTION_MAX_BATCHES = 25;

/**
 * Состояния пакета, после которых его улики уже никто не прочитает.
 *
 * Список закрытый и сверен с кодом: пакет бывает `queued`, `processing`,
 * `parsed` и `parse_failed`. Первые два означают, что обработка ещё идёт или
 * будет подобрана восстановлением, — такие улики не трогаем независимо от
 * возраста.
 */
const TERMINAL_BUNDLE_STATUSES = ['parsed', 'parse_failed'] as const;

export type RetentionResult = {
  llmCallsDeleted: number;
  evidenceDeleted: number;
  /** Упёрлись в потолок батчей — остаток уйдёт в следующий прогон. */
  llmCallsCapped: boolean;
  evidenceCapped: boolean;
};

/**
 * Батчи удаления. Считаем строки по `RETURNING id`, а не по счётчику драйвера:
 * у postgres-js число удалённых строк лежит не там, где у node-postgres, и
 * ошибка в этом месте тиха — чистка «работает», отчитываясь нулями.
 */
async function deleteInBatches(
  db: Db,
  statement: (limit: number) => ReturnType<typeof sql>,
): Promise<{ deleted: number; capped: boolean }> {
  let deleted = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const rows = (await db.execute(statement(RETENTION_BATCH_SIZE))) as unknown as
      | { id: string }[]
      | { rows?: { id: string }[] };
    const n = Array.isArray(rows) ? rows.length : (rows.rows?.length ?? 0);
    deleted += n;
    if (n < RETENTION_BATCH_SIZE) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

/**
 * Удаляет устаревшие записи журналов. Значение `0` в днях выключает чистку
 * соответствующей таблицы целиком — это и есть поведение по умолчанию.
 */
export async function cleanupRecognitionLogs(args: {
  db: Db;
  llmCallsDays: number;
  evidenceDays: number;
}): Promise<RetentionResult> {
  const { db, llmCallsDays, evidenceDays } = args;
  const result: RetentionResult = {
    llmCallsDeleted: 0,
    evidenceDeleted: 0,
    llmCallsCapped: false,
    evidenceCapped: false,
  };

  if (llmCallsDays > 0) {
    const r = await deleteInBatches(
      db,
      (limit) => sql`
        DELETE FROM llm_calls
        WHERE id IN (
          SELECT id FROM llm_calls
          WHERE created_at < now() - make_interval(days => ${llmCallsDays})
          ORDER BY created_at
          LIMIT ${limit}
        )
        RETURNING id
      `,
    );
    result.llmCallsDeleted = r.deleted;
    result.llmCallsCapped = r.capped;
  }

  if (evidenceDays > 0) {
    const r = await deleteInBatches(
      db,
      (limit) => sql`
        DELETE FROM recognition_evidence_events
        WHERE id IN (
          SELECT e.id FROM recognition_evidence_events e
          WHERE e.created_at < now() - make_interval(days => ${evidenceDays})
            -- Пакет обязан быть в терминальном состоянии, и незавершённых
            -- дочерних пакетов у него быть не должно: пока обработка жива,
            -- улику ещё может прочитать откат сборки или аудит нумерации.
            AND EXISTS (
              SELECT 1 FROM source_bundles b
              WHERE b.id = e.bundle_id
                AND b.status = ANY (${sql.raw(
                  `ARRAY[${TERMINAL_BUNDLE_STATUSES.map((s) => `'${s}'`).join(',')}]`,
                )})
            )
            AND NOT EXISTS (
              SELECT 1 FROM source_bundles c
              WHERE c.parent_bundle_id = e.bundle_id
                AND c.status <> ALL (${sql.raw(
                  `ARRAY[${TERMINAL_BUNDLE_STATUSES.map((s) => `'${s}'`).join(',')}]`,
                )})
            )
          ORDER BY e.created_at
          LIMIT ${limit}
        )
        RETURNING id
      `,
    );
    result.evidenceDeleted = r.deleted;
    result.evidenceCapped = r.capped;
  }

  return result;
}
