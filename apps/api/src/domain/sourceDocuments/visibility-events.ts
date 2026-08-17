/**
 * Журнал переходов видимости: как планшет узнаёт, что документ ПРОПАЛ.
 *
 * Дельта /sync отбирает документы по `updated_at`, а скрытие часто происходит
 * без изменения самого документа: соседний документ машины ушёл на переразбор,
 * в пачку добавился ещё не разобранный файл, у документа сняли объект. Планшет
 * такого не заметит никогда и продолжит показывать машину, которой больше нет.
 *
 * Вычислить «что пропало с прошлого since» на лету нельзя: для этого нужны два
 * снимка, а второго нет ни у сервера, ни у клиента. Планшет уходит в офлайн на
 * дни — за это время документ мог скрыться и снова появиться. Поэтому переходы
 * пишутся в журнал, и он переживает офлайн любой длины.
 */
import { sql } from 'drizzle-orm';
import { mobileVisibleSourceDocumentSql } from './mobile-visibility.js';

/**
 * Записывает переходы видимости для документов, затронутых изменением.
 *
 * Событие пишется ТОЛЬКО при смене состояния: повторный вызов на неизменившемся
 * документе ничего не добавляет. Иначе журнал рос бы на каждый разбор, а клиент
 * получал бы поток холостых удалений.
 *
 * `documentIds` пустой — обрабатываются все документы группы. Так вызывается из
 * публикации комплекта и при смене состава: там меняется видимость СОСЕДЕЙ, а не
 * того документа, который правили.
 *
 * Вызывать ВНУТРИ той же транзакции, что и само изменение: иначе планшет успеет
 * забрать документ между правкой и записью события.
 */
export async function recordVisibilityTransitions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: { documentIds?: string[]; groupId?: string; reason: string },
): Promise<void> {
  const { documentIds, groupId, reason } = opts;
  if (!documentIds?.length && !groupId) return;

  // Набор документов: явный список плюс, если задана группа, все её члены —
  // включая документы дочерних пакетов (там живут накладные).
  // Без алиаса таблицы: предикат видимости собран из колонок drizzle и
  // разворачивается в "source_documents"."...". Дав таблице алиас, мы получили
  // бы «invalid reference to FROM-clause entry».
  const scope = groupId
    ? sql`source_documents.id in (
        select m.id
          from source_documents m
          join source_bundles mb on mb.id = m.bundle_id
         where coalesce(mb.parent_bundle_id, mb.id) = ${groupId}
      )${
        documentIds?.length
          ? sql` or source_documents.id in (${sql.join(
              documentIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }`
    : sql`source_documents.id in (${sql.join(
        documentIds!.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;

  await tx.execute(sql`
    with current_state as (
      select source_documents.id,
             source_documents.site_id,
             ${mobileVisibleSourceDocumentSql} as visible
        from source_documents
       where ${scope}
    ),
    last_event as (
      select distinct on (e.source_document_id)
             e.source_document_id, e.visibility
        from source_document_visibility_events e
       where e.source_document_id in (select id from current_state)
       order by e.source_document_id, e.created_at desc, e.id desc
    )
    insert into source_document_visibility_events
      (source_document_id, visibility, site_id, group_id, reason)
    select c.id,
           case when c.visible then 'visible' else 'hidden' end,
           c.site_id,
           ${groupId ?? null}::uuid,
           ${reason}
      from current_state c
      left join last_event l on l.source_document_id = c.id
     where
       -- Первое событие пишем только для СКРЫТИЯ. «Появился» — это обычная
       -- дельта по updated_at, отдельное событие ей ничего не добавляет, а
       -- журнал раздуло бы на каждый разобранный документ.
       (l.visibility is null and c.visible = false)
       or (l.visibility is not null
           and l.visibility <> case when c.visible then 'visible' else 'hidden' end)
  `);
}

/**
 * Документы, которые надо снять с планшета, — для поля deletedIds дельты.
 *
 * Схлопывание обязательно: если между двумя синхронизациями документ скрылся и
 * снова появился, клиенту нужно ТОЛЬКО актуальное конечное состояние. Без
 * схлопывания он получил бы id и в списке документов, и в списке удалений
 * одновременно, а порядок применения (сначала документы, потом удаления)
 * означал бы, что документ будет стёрт сразу после записи.
 *
 * Поэтому отбираем по последнему событию на документ, а не по всем событиям
 * после since.
 */
export async function selectVisibilityTombstones(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { since: Date; siteId?: string | null; limit?: number },
): Promise<string[]> {
  const { since, siteId, limit = 1000 } = opts;
  const siteFilter = siteId ? sql`and e.site_id = ${siteId}::uuid` : sql``;

  const rows = await db.execute(sql`
    select distinct on (e.source_document_id)
           e.source_document_id as id, e.visibility
      from source_document_visibility_events e
     where e.created_at >= ${since.toISOString()}::timestamptz
       ${siteFilter}
     order by e.source_document_id, e.created_at desc, e.id desc
     limit ${limit}
  `);

  return [...rows].filter((r: { visibility: string }) => r.visibility === 'hidden').map(
    (r: { id: string }) => r.id,
  );
}
