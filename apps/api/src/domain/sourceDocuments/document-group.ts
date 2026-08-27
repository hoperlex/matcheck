// Группа документов одной «машины»: какие source_documents приехали одним
// рейсом и потому должны стать ОДНОЙ приёмкой на планшете.
//
// Одна карточка «Машина N» на публичной странице /uploads = один POST = один
// корневой пакет (см. PublicUploadModal: «каждая уезжает своим запросом»).
// Из пакета может выйти несколько документов — две УПД плюс транспортная
// накладная в одной пачке фото. Без общего идентификатора планшет рисует их
// отдельными карточками, и инспектор оформляет одну и ту же машину несколько
// раз, а остаток документов висит в «Сегодня» как неоформленный.
//
// Живёт в domain рядом с public-origin.ts и по той же причине: правило нужно и
// /sync, и detail-роуту, а держать его в двух местах — гарантированный
// рассинхрон, когда одно из них поправят.

import { sql, type SQL } from 'drizzle-orm';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';

/**
 * Сборка, при которой группу вообще можно склеивать.
 *
 * Прежнее правило, действует пока GROUPS_ROLLOUT выключен.
 *
 * legacy — «файл = документ»: многостраничную УПД, снятую по кадру на
 * страницу, разбор превратит в N документов с частичными позициями, и склейка
 * дала бы задвоенный список материалов. Там группа = сам документ.
 * logical_v1 — границы документов уже логические, группа = корневой пакет.
 * См. миграцию 0096_multi_upd_delivery.sql.
 *
 * Опасение про задвоенный список проверено на боевых данных перед сменой
 * правила: среди публичных машин нет ни одной, где два ВИДИМЫХ документа несли
 * бы одинаковый номер, а пересечений позиций у несобранных машин ноль.
 */
const GROUPABLE_ASSEMBLY = 'logical_v1';

/** Алиасы, под которыми корневой пакет доступен в местах вызова. */
type RootAlias = 'root' | 'sb' | 'member_root';

/**
 * «Этот корневой пакет — машина», единственное правило на все точки.
 *
 * Новое (GROUPS_ROLLOUT=1): машина — это одна отправка с публичной страницы
 * /uploads. Признак известен в момент приёма и не зависит от того, удалась ли
 * постраничная сборка УПД: она откатывается (см. rollbackUpdAssembly), и
 * поставка разваливалась на отдельные карточки у инспектора. За месяц так
 * рассыпались 27 машин из 66.
 *
 * Старое (GROUPS_ROLLOUT=0): машиной считается только успешно собранный и
 * опубликованный пакет. Оставлено для мгновенного отката без выката.
 *
 * ОДНО И ТО ЖЕ правило обязано применяться в четырёх местах: group_id,
 * group_revision, проверка комплектности машины (mobile-visibility) и бамп
 * ревизии. Разъедься они — group_id без комплектности пропустит готовый
 * документ вперёд разбирающегося соседа, а без бампа планшет не узнает о смене
 * состава.
 *
 * @param alias как назван корневой пакет в вызывающем запросе. Значения
 *   перечислены типом: строка приходит только из нашего кода, не из запроса.
 */
export function machineRootSql(alias: RootAlias = 'root'): SQL {
  const root = sql.raw(alias);
  const env = loadEnv();
  if (env.GROUPS_ROLLOUT) {
    // Отсечка по дате приёма: новая модель распространяется только на пачки,
    // загруженные ПОСЛЕ выката. Пакет, который инспекторы уже видели, менять
    // задним числом нельзя — у него сложился состав машины и часть документов
    // оформлена.
    const since = env.GROUPS_ROLLOUT_SINCE;
    const notOlder = since
      ? sql` and ${root}.created_at >= ${since.toISOString()}::timestamptz`
      : sql``;
    return sql`(exists (
      select 1 from ingest_events ie
       where ie.bundle_id = ${root}.id and ie.channel = 'public'
    )${notOlder})`;
  }
  return sql`${root}.assembly_version = ${GROUPABLE_ASSEMBLY}
   and ${root}.published_generation is not null
   and ${root}.published_generation = ${root}.active_upload_generation`;
}

/**
 * Идентификатор «машины» для документа: id КОРНЕВОГО пакета.
 *
 * COALESCE(parent_bundle_id, id): накладные и сборку УПД router разворачивает в
 * ДОЧЕРНИЙ пакет, и реальный документ висит уже на нём, тогда как машина — это
 * родитель. Та же оговорка, что у fromSupplierPortalSql.
 *
 * Скалярный подзапрос, а не JOIN: фрагмент подставляется в выборки, устройство
 * которых менять не хочется. Размножить строки он не может — bundle_id у
 * документа один, и обе связи идут по первичному ключу.
 *
 * Как и fromSupplierPortalSql, работает ТОЛЬКО внутри выборки по таблице
 * source_documents: ссылается на её колонку bundle_id.
 *
 * Функция, а не константа: правило машины зависит от GROUPS_ROLLOUT, и
 * значение, зафиксированное при импорте модуля, нельзя было бы ни переключить
 * на работающем сервере, ни проверить тестом.
 */
export function documentGroupIdSql(): SQL<string | null> {
  return sql<string | null>`(
  select case when ${machineRootSql('root')} then root.id end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;
}

/**
 * Машина ДЛЯ ПОРТАЛА: та же группа, но видимая менеджеру с первой секунды.
 *
 * Отличается от `documentGroupIdSql` одним — не ждёт ни логической сборки, ни
 * публикации. Менеджеру машина нужна раньше инспектора: он смотрит на пачку,
 * пока она разбирается, и должен видеть, что эти семь строк приехали одним
 * рейсом. Планшетный `groupId` для этого не годится: до публикации он NULL, а
 * после отката сборки NULL навсегда, и в списке остаётся россыпь.
 *
 * Ограничен публичным каналом намеренно. «Корневой пакет всегда» задело бы
 * почту, внутренние загрузки и все исторические пакеты: там пачка файлов не
 * означает один рейс, и метка машины сбивала бы с толку. Признак тот же, что
 * у `fromSupplierPortalSql`, — событие приёма на КОРНЕ (накладные и сборка
 * живут в дочерних пакетах, событие остаётся у родителя).
 *
 * Как и остальные фрагменты здесь, работает только внутри выборки по
 * source_documents: ссылается на её колонку bundle_id.
 */
export const portalDocumentGroupIdSql = sql<string | null>`(
  select case
           when exists (
             select 1 from ingest_events ie
              where ie.bundle_id = root.id and ie.channel = 'public'
           )
           then root.id
         end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;

/**
 * Сколько строк в машине глазами менеджера.
 *
 * Считает нетехнические документы того же корневого пакета — то есть ровно то,
 * что переедет вместе с документом при смене объекта (см. site-transfer.ts).
 * Карточка показывает это число ДО сохранения: «объект сменится у всей машины
 * (N док.)».
 *
 * Ограничен публичным каналом по той же причине, что portalDocumentGroupIdSql:
 * у почты и внутренних загрузок пачка файлов не означает один рейс.
 */
export const portalDocumentGroupSizeSql = sql<number | null>`(
  select case
           when exists (
             select 1 from ingest_events ie
              where ie.bundle_id = root.id and ie.channel = 'public'
           )
           then (
             select count(*)::int
               from ${sourceDocuments} member
               join ${sourceBundles} mb on mb.id = member.bundle_id
              where coalesce(mb.parent_bundle_id, mb.id) = root.id
                and member.is_technical = false
           )
         end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;

/**
 * Версия состава группы. Растёт и когда в машину добавился документ, и когда
 * поменялись реквизиты или позиции любого из её документов.
 *
 * Планшет запоминает значение на момент загрузки формы и сверяет перед
 * финализацией: «состав тот же, но суммы другие» сравнением множества id не
 * ловится, а привязать к приёмке документ, позиций которого инспектор не
 * видел, нельзя.
 *
 * Функция по той же причине, что и documentGroupIdSql: правило под рубильником.
 */
export function documentGroupRevisionSql(): SQL<number | null> {
  return sql<number | null>`(
  select case when ${machineRootSql('root')} then root.group_revision end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;
}

/**
 * Публикация собранного комплекта: снять «технический» флаг с сегментов и
 * донести до планшета ВСЮ группу.
 *
 * Почему группу, а не только сегменты. Накладная и М-15 создаются на корневом
 * пакете РАНЬШЕ публикации, когда assembly_version ещё 'legacy' и вычисляемый
 * group_id у них NULL. Публикация переводит корень в logical_v1 — их group_id
 * меняется САМ, без единой записи в source_documents. Планшет такое изменение
 * не увидит ни одним каналом: дельта /sync отбирает по updated_at, reconcile —
 * по version > clientVersion, а SSE лишь просит синхронизироваться той же
 * дельтой. Накладная навсегда осталась бы у инспектора отдельной карточкой.
 *
 * Один UPDATE по объединению, а не два подряд: сегменты в этот момент ещё
 * is_technical = true (их как раз публикуют), поэтому фильтр по
 * is_technical = false их бы не захватил, а вторым UPDATE они получили бы
 * двойной инкремент version. Для уже видимых документов is_technical = false —
 * no-op.
 *
 * Вызывать ВНУТРИ транзакции публикации.
 */
export async function publishGroupDocuments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  rootId: string,
  segmentDocIds: string[],
  now: Date,
): Promise<void> {
  // Параметрами, а не интерполяцией: id приходят из БД, но собирать SQL
  // конкатенацией строк — привычка, которая рано или поздно встретит вход из
  // запроса. Пустой список даёт заведомо ложное условие, а не `in ()`, на
  // котором Postgres падает синтаксически.
  const idList = segmentDocIds.length
    ? sql`sd.id in (${sql.join(
        segmentDocIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`false`;
  // ISO-строкой с явным кастом, а не объектом Date: в сыром sql-шаблоне drizzle
  // Date не сериализует и падает на «argument must be of type string».
  await tx.execute(sql`
    update ${sourceDocuments} sd
       set is_technical = false,
           updated_at = ${now.toISOString()}::timestamptz,
           version = sd.version + 1
      from ${sourceBundles} b
     where b.id = sd.bundle_id
       and (
         ${idList}
         or (sd.is_technical = false and coalesce(b.parent_bundle_id, b.id) = ${rootId})
       )
  `);
}

/**
 * Отметить, что содержимое группы изменилось: поднять group_revision её
 * корневого пакета и донести это до планшета.
 *
 * Зачем бампать ВСЕ документы группы, а не только изменившийся. Ревизия
 * хранится на пакете, а планшет читает её через каждый документ
 * (documentGroupRevisionSql). Дельта /sync отбирает по source_documents
 * .updated_at, reconcile — по version: тронь мы только переразобранный
 * документ, его сиблинги остались бы в Room со старой ревизией, и сверка
 * состава на форме разошлась бы сама с собой.
 *
 * Для пакета, который машиной не является (почта, ЭДО, внутренняя загрузка),
 * no-op: там группы нет, ревизия ничего не значит. ВАЖНО: no-op здесь касается
 * не только ревизии, но и побочного эффекта «поднять updated_at документов», —
 * через него планшет узнаёт об изменении вообще. Поэтому правило машины должно
 * быть тем же, что у group_id: разъехавшись, они дают документ, который сменил
 * состав молча.
 *
 * `statement_timestamp()`, а не `now()`: последний возвращает время НАЧАЛА
 * транзакции. Курсор /sync берётся с запасом от текущего времени, и отметка,
 * проставленная началом длинной транзакции, оказывается ниже уже отданного
 * курсора — документ не приедет НИКОГДА. См. тот же приём в visibility-events.
 *
 * Вызывать ВНУТРИ той же транзакции, что и само изменение, — иначе планшет
 * может успеть забрать документ до бампа и не узнать о правке.
 */
export async function bumpGroupRevision(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  sourceDocumentId: string,
): Promise<void> {
  await tx.execute(sql`
    with root as (
      select coalesce(b.parent_bundle_id, b.id) as id
        from ${sourceDocuments} sd
        join ${sourceBundles} b on b.id = sd.bundle_id
       where sd.id = ${sourceDocumentId}
    ),
    bumped as (
      update ${sourceBundles} sb
         set group_revision = sb.group_revision + 1,
             updated_at = statement_timestamp()
        from root
       where sb.id = root.id
         and ${machineRootSql('sb')}
      returning sb.id
    )
    update ${sourceDocuments} sd
       set updated_at = statement_timestamp(),
           version = sd.version + 1
      from ${sourceBundles} b, bumped
     where b.id = sd.bundle_id
       and coalesce(b.parent_bundle_id, b.id) = bumped.id
       and sd.is_technical = false
  `);
}

/**
 * Отметить, что РАСПОЗНАННОЕ СОДЕРЖИМОЕ документа заменено: шапка и позиции
 * переписаны заново, и планшет обязан забрать документ заново.
 *
 * Зачем отдельно от [bumpGroupRevision], хотя тело почти совпадает. Тот —
 * про смену СОСТАВА машины, и для пакета, машиной не являющегося, он
 * no-op ЦЕЛИКОМ: пустой CTE `bumped` обнуляет и финальный UPDATE. Для смены
 * состава это верно (нет машины — нет и состава), а для смены содержимого
 * губительно: одиночный документ после повторного распознавания оставался с
 * прежним `version`, и сверка его не находила.
 *
 * Замер на бою 27.08: из 72 успешных повторов за 30 дней у 52 версия так и
 * осталась равной единице — 34 одиночные УПД (машины нет) и 18 накладных
 * (путь waybill_single бампа не звал вовсе). Планшет, пропустивший дельту,
 * оставался с пустой карточкой навсегда: `/sync` отбирает по `updated_at`,
 * а `/sync/reconcile` — строго по `version > clientVersion`.
 *
 * Правило: изменённый документ бампается ВСЕГДА, машина и её соседи — если
 * машина есть. Один UPDATE на оба случая, поэтому строка, попавшая под оба
 * условия сразу, инкрементируется РОВНО ОДИН раз; два отдельных запроса дали
 * бы документу машины двойной инкремент.
 *
 * `statement_timestamp()`, а не `now()`: последний возвращает время НАЧАЛА
 * транзакции, курсор /sync берётся с запасом от текущего времени, и отметка
 * от начала длинной транзакции оказывается ниже уже отданного курсора —
 * документ не приедет НИКОГДА. Та же причина, что у bumpGroupRevision.
 *
 * Соседи ищутся через EXISTS, а не через FROM-джойн пакета: документ из EDO
 * или почты живёт БЕЗ пакета вовсе, и джойн выбросил бы его из выдачи —
 * то есть повторил бы ровно тот дефект, ради которого helper и заводится.
 *
 * Вызывать ВНУТРИ той же транзакции, что и замена шапки с позициями, и ТОЛЬКО
 * после того, как запись подтвердилась: устаревшее поколение обязано отломиться
 * раньше (StaleGenerationError), иначе оно добавит свой инкремент поверх уже
 * актуальной версии.
 */
export async function markSourceDocumentContentChanged(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  sourceDocumentId: string,
): Promise<void> {
  await tx.execute(sql`
    with root as (
      select coalesce(b.parent_bundle_id, b.id) as id
        from ${sourceDocuments} sd
        join ${sourceBundles} b on b.id = sd.bundle_id
       where sd.id = ${sourceDocumentId}
    ),
    bumped as (
      update ${sourceBundles} sb
         set group_revision = sb.group_revision + 1,
             updated_at = statement_timestamp()
        from root
       where sb.id = root.id
         and ${machineRootSql('sb')}
      returning sb.id
    )
    update ${sourceDocuments} sd
       set updated_at = statement_timestamp(),
           version = sd.version + 1
     where sd.is_technical = false
       and (
         sd.id = ${sourceDocumentId}
         or exists (
           select 1
             from ${sourceBundles} b
            where b.id = sd.bundle_id
              and coalesce(b.parent_bundle_id, b.id) in (select id from bumped)
         )
       )
  `);
}
