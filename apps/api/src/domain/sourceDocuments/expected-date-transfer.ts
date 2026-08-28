// Смена даты поставки: у поставки с портала дата — свойство МАШИНЫ, а не строки.
//
// Дату называет поставщик на публичной странице: она пишется в пакет и оттуда
// копируется в каждый документ рейса. Правка одной строки разводила машину по
// разным дням, и ломалось это не косметически:
//
//   * пустая дата у ОДНОГО документа гасит на планшете ВСЮ машину
//     (groupIsCompleteSql в mobile-visibility.ts), причём соседи гаснут без
//     метки видимости и обратно не возвращаются ни дельтой, ни сверкой;
//   * вкладку «Сегодня» планшет считает по якорному документу машины, а
//     счётчик на главном — по любому: при разных датах счётчик показывает
//     поставку, которой во вкладке нет;
//   * пакет сохранял ПРЕЖНЮЮ дату, и следующая же дозагрузка, заглушка или
//     пересборка заводили документ обратно со старой датой.
//
// Поэтому операция устроена как перенос объекта (site-transfer.ts): блокировки
// берёт вызывающий (lockMachine), канонические ключи корня он же пересчитывает
// после обоих переносов — дата входит в тот же ключ, что и объект.
//
// Проверки «по машине уже оформлена операция» здесь намеренно НЕТ, в отличие от
// объекта. Объект блокируется потому, что он записан в самой приёмке и перенос
// порвал бы связь; даты поставки в deliveries нет вовсе (там только arrived_at
// с планшета). Запрет означал бы новое ограничение там, где правка сегодня
// разрешена.

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';
import type { MachineDoc, MachineLock } from './machine-lock.js';

export type ExpectedDateTransfer =
  /** Дата не изменилась — писать нечего. */
  | { changed: false }
  | {
      changed: true;
      /** Значения в форме ключа: 'YYYY-MM-DD' либо null. */
      fromDateKey: string | null;
      toDateKey: string | null;
      /** Корень машины; null — дата меняется у одного документа. */
      rootBundleId: string | null;
      /** Нетехнические документы, которым сменили дату. */
      documentIds: string[];
    };

/**
 * Ставит дату поставки документу и всей его портальной машине.
 *
 * @param toDateKey дата в форме ключа ('YYYY-MM-DD') либо null. Строка, а не
 *   Date: `expected_date` — timestamp без таймзоны, и любой прогон через JS-Date
 *   на сервере с TZ ≠ UTC сдвинул бы день. Приведение делает уже Postgres.
 */
export async function transferExpectedDate(
  tx: Db,
  lock: MachineLock,
  toDateKey: string | null,
): Promise<ExpectedDateTransfer> {
  const fromDateKey = lock.self.expectedDateKey;
  // No-op ПЕРВЫМ делом: форма кладёт дату в тело при каждом сохранении, даже
  // когда правили одну сумму. Без этой проверки любое открытие карточки
  // переписывало бы дату всей машине и дёргало планшет.
  if ((fromDateKey ?? null) === (toDateKey ?? null)) return { changed: false };

  // Документ вне публичной загрузки отвечает сам за себя — см. шапку
  // site-transfer.ts: там пачка файлов не означает один рейс.
  const targets: MachineDoc[] = lock.machineRootId ? lock.docs : [lock.self];

  // Дельта /sync отбирает по updated_at, сверка — по version, поэтому оба поля
  // бампаются безусловно: bumpGroupRevision условен (рубильник, непортальный
  // пакет) и молча оставил бы новую дату без уведомления планшета.
  const visibleIds = targets.filter((d) => !d.isTechnical).map((d) => d.id);
  if (visibleIds.length > 0) {
    await tx.execute(sql`
      update ${sourceDocuments}
         set expected_date = ${toDateKey}::date,
             updated_at = statement_timestamp(),
             version = version + 1
       where id in (${sql.join(
         visibleIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
  }
  const technicalIds = targets.filter((d) => d.isTechnical).map((d) => d.id);
  if (technicalIds.length > 0) {
    // Служебные записи на планшет не едут: version им не нужен, а дата нужна —
    // по ней создаются заглушки и сегменты сборки.
    await tx.execute(sql`
      update ${sourceDocuments}
         set expected_date = ${toDateKey}::date,
             updated_at = statement_timestamp()
       where id in (${sql.join(
         technicalIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
  }

  if (lock.machineRootId && lock.bundleIds.length > 0) {
    // Пакет — источник даты для всего, что появится в машине позже
    // (дозагрузка, заглушка «не распознано», сегменты сборки). Без этой записи
    // ручная правка держалась бы ровно до следующего файла.
    await tx.execute(sql`
      update ${sourceBundles}
         set expected_date = ${toDateKey}::date,
             updated_at = statement_timestamp()
       where id in (${sql.join(
         lock.bundleIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
  }

  return {
    changed: true,
    fromDateKey,
    toDateKey,
    rootBundleId: lock.machineRootId,
    documentIds: visibleIds,
  };
}

/**
 * Дата поставки машины, какой она записана в БД ПРЯМО СЕЙЧАС.
 *
 * Зеркало resolveMachineSiteId и нужна ровно за тем же: строку пакета воркер
 * читает ДО транзакции, а внутри берёт лишь fence, поэтому задание, ждавшее
 * блокировку во время правки даты, создало бы документ со СТАРОЙ датой из
 * памяти — и машина разъехалась бы по дням сама, без участия человека.
 *
 * Значение корня берётся КАК ЕСТЬ, включая null: пустая дата — это намеренно
 * снятая дата, и coalesce с датой дочернего пакета воскресил бы её. Корень
 * определён всегда (coalesce(parent_bundle_id, id)).
 *
 * Читается через to_char и собирается из UTC-полуночи: колонка — timestamp БЕЗ
 * таймзоны, и Date из драйвера зависел бы от TZ процесса, а `new Date('YYYY-MM-DD')`
 * от неё не зависит вовсе. Значение готово к вставке в колонку как есть.
 */
export async function resolveMachineExpectedDate(
  tx: Db,
  bundleId: string | null,
): Promise<Date | null> {
  if (!bundleId) return null;
  const rows = await tx.execute<{ expected_date_key: string | null }>(sql`
    select to_char(rb.expected_date, 'YYYY-MM-DD') as expected_date_key
      from ${sourceBundles} b
      join ${sourceBundles} rb on rb.id = coalesce(b.parent_bundle_id, b.id)
     where b.id = ${bundleId}::uuid
  `);
  const key = [...rows][0]?.expected_date_key ?? null;
  return key ? new Date(`${key}T00:00:00Z`) : null;
}
