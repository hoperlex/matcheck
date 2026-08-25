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
             -- Объект события. У ПОРТАЛЬНОЙ машины — объект корневого пакета:
             -- он задан на форме загрузки, общий для всей машины и меняется
             -- только вместе с ней (см. site-transfer.ts). У всех остальных
             -- (почта, ЭДО, ручная загрузка, документ без пакета) — объект
             -- самого документа: там пачка файлов не означает один рейс, объект
             -- переносится поштучно, и метка, адресованная объекту пакета, ушла
             -- бы не на тот планшет, а следующий visible затёр бы hidden,
             -- записанный переносом.
             case
               when m.is_portal then m.root_site_id
               else coalesce(source_documents.site_id, m.root_site_id)
             end as site_id,
             ${mobileVisibleSourceDocumentSql()} as visible
        from source_documents
        left join lateral (
          select rb.site_id as root_site_id,
                 exists (
                   select 1 from ingest_events ie
                    where ie.bundle_id = rb.id and ie.channel = 'public'
                 ) as is_portal
            from source_bundles sb
            join source_bundles rb on rb.id = coalesce(sb.parent_bundle_id, sb.id)
           where sb.id = source_documents.bundle_id
        ) m on true
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
      (source_document_id, visibility, site_id, group_id, reason, created_at)
    select c.id,
           case when c.visible then 'visible' else 'hidden' end,
           c.site_id,
           ${groupId ?? null}::uuid,
           ${reason},
           -- НЕ полагаемся на DEFAULT now(): он даёт время НАЧАЛА транзакции.
           -- Курсор /sync отходит назад на фиксированное окно от текущего
           -- времени, поэтому событие, помеченное началом длинной транзакции,
           -- оказывается ниже уже отданного курсора и не приезжает НИКОГДА.
           -- statement_timestamp() плюс правило «запись события — последняя
           -- операция транзакции» плюс окно курсора больше предельной
           -- длительности транзакции дают вместе формальную гарантию доставки.
           statement_timestamp()
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
 * Причина события при переносе объекта. Отдельная константа, потому что по ней
 * `/sync` отбирает tombstone'ы даже с выключенным GROUPS_ROLLOUT: смена объекта —
 * не групповая механика, а базовая корректность выдачи.
 */
export const SITE_TRANSFER_REASON = 'объект документа изменён';

/**
 * Метки для планшетов при переносе документа (или всей машины) на другой объект.
 *
 * Зачем отдельно от `recordVisibilityTransitions`. Тот пишет событие только на
 * ФАКТИЧЕСКИЙ переход видимости, а при переезде A→B документ как был видимым,
 * так и остаётся: события нет, дельта прежнего объекта его больше не привозит —
 * и карточка живёт на планшете старого объекта вечно (reconcile лишнее не
 * удаляет, локального фильтра по объекту у мобилы нет).
 *
 * Поэтому здесь события пишутся БЕЗУСЛОВНО и парой:
 *   * `hidden` на прежний объект — команда «убери», а не описание состояния;
 *   * `visible`/`hidden` на новый — иначе обратный перенос B→A не смог бы
 *     отменить старую метку: выборка по одной лишь причине переноса продолжала
 *     бы видеть `hidden` последним событием объекта A.
 *
 * Обе строки одного объекта не пересекаются: tombstone'ы отбираются с фильтром
 * по `site_id`, а `fromSiteId` ≠ `toSiteId` (равенство отсекает вызывающий).
 *
 * Вызывать ВНУТРИ транзакции переноса, последними операциями — как и соседний
 * `recordVisibilityTransitions` (см. пояснение про statement_timestamp там же).
 */
export async function recordSiteTransfer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: { documentIds: string[]; fromSiteId: string | null; toSiteId: string | null },
): Promise<void> {
  const { documentIds, fromSiteId, toSiteId } = opts;
  if (documentIds.length === 0) return;
  const idList = sql.join(
    documentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Технические записи на планшет не едут — метки им не адресуются.
  const scope = sql`source_documents.id in (${idList}) and source_documents.is_technical = false`;

  if (fromSiteId) {
    await tx.execute(sql`
      insert into source_document_visibility_events
        (source_document_id, visibility, site_id, reason, created_at)
      select source_documents.id, 'hidden', ${fromSiteId}::uuid, ${SITE_TRANSFER_REASON},
             statement_timestamp()
        from source_documents
       where ${scope}
    `);
  }
  if (toSiteId) {
    await tx.execute(sql`
      insert into source_document_visibility_events
        (source_document_id, visibility, site_id, reason, created_at)
      select source_documents.id,
             case when ${mobileVisibleSourceDocumentSql()} then 'visible' else 'hidden' end,
             ${toSiteId}::uuid, ${SITE_TRANSFER_REASON}, statement_timestamp()
        from source_documents
       where ${scope}
    `);
  }
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
  opts: { since: Date; siteId?: string | null; limit?: number; reasons?: string[] },
): Promise<string[]> {
  // Предел поднят с 1000 намеренно. Отсечка здесь необратима: список удалений
  // не пагинируется, а курсор после ответа уходит вперёд — всё, что не влезло,
  // теряется навсегда, и документ остаётся на планшете до переустановки. Тысяча
  // достигалась разово при массовом скрытии (выкатной прогон, чистка объекта).
  // Строка ответа — это один uuid, поэтому даже десятки тысяч дешевле, чем один
  // потерянный tombstone.
  const { since, siteId, limit = 50_000, reasons } = opts;
  const siteFilter = siteId ? sql`and e.site_id = ${siteId}::uuid` : sql``;
  // Сужение по причинам — для режима, когда правило видимости ещё не выкачено
  // (GROUPS_ROLLOUT=0). Журнал наполняет и воркер, поэтому отдать его целиком
  // означало бы применить новое правило задним числом; переносы объекта же
  // обязаны доезжать всегда. Отбор идёт ПОСЛЕ фильтра, то есть берётся
  // последнее событие нужного вида — ровно поэтому перенос пишет и `visible`
  // на новый объект (см. recordSiteTransfer).
  const reasonFilter =
    reasons && reasons.length > 0
      ? sql`and e.reason in (${sql.join(
          reasons.map((r) => sql`${r}`),
          sql`, `,
        )})`
      : sql``;

  const rows = await db.execute(sql`
    select distinct on (e.source_document_id)
           e.source_document_id as id, e.visibility
      from source_document_visibility_events e
     where e.created_at >= ${since.toISOString()}::timestamptz
       ${siteFilter}
       ${reasonFilter}
     order by e.source_document_id, e.created_at desc, e.id desc
     limit ${limit}
  `);

  return [...rows]
    .filter((r: { visibility: string }) => r.visibility === 'hidden')
    .map((r: { id: string }) => r.id);
}
