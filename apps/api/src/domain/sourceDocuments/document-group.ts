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

import { sql } from 'drizzle-orm';
import { sourceBundles, sourceDocuments } from '../../db/schema.js';

/**
 * Сборка, при которой группу вообще можно склеивать.
 *
 * legacy — «файл = документ»: многостраничную УПД, снятую по кадру на
 * страницу, разбор превратит в N документов с частичными позициями, и склейка
 * дала бы задвоенный список материалов. Там группа = сам документ.
 * logical_v1 — границы документов уже логические, группа = корневой пакет.
 * См. миграцию 0096_multi_upd_delivery.sql.
 */
const GROUPABLE_ASSEMBLY = 'logical_v1';

/**
 * Группа существует, только пока опубликованное поколение совпадает с активным.
 *
 * `assembly_version` одного мало. Оно означает «этот пакет когда-то собрали
 * логически» и после публикации не пересматривается. А `active_upload_generation`
 * растёт при каждой повторной отправке того же комплекта (см. ingest-bundle,
 * ветка CAS-рестарта): в этот момент старые документы ещё висят в базе, новые
 * только начинают создаваться, и группа находится в промежуточном состоянии.
 *
 * Без этого условия планшет успел бы забрать полусобранную машину: часть
 * документов нового поколения уже готова, часть ещё в разборе, а `groupId` у
 * них общий — инспектор принял бы неполный состав, считая его полным.
 *
 * Сравнение с `published_generation` заодно даёт бесплатный staging: инкремента
 * активного поколения достаточно, чтобы группа исчезла из выдачи, и отдельного
 * «перевести корень в staging» писать не нужно.
 */
const PUBLISHED_GENERATION_IS_CURRENT = sql`root.published_generation is not null
   and root.published_generation = root.active_upload_generation`;

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
 */
export const documentGroupIdSql = sql<string | null>`(
  select case
           when root.assembly_version = ${GROUPABLE_ASSEMBLY}
            and ${PUBLISHED_GENERATION_IS_CURRENT}
           then root.id
         end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;

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
 * Версия состава группы. Растёт и когда в машину добавился документ, и когда
 * поменялись реквизиты или позиции любого из её документов.
 *
 * Планшет запоминает значение на момент загрузки формы и сверяет перед
 * финализацией: «состав тот же, но суммы другие» сравнением множества id не
 * ловится, а привязать к приёмке документ, позиций которого инспектор не
 * видел, нельзя.
 */
export const documentGroupRevisionSql = sql<number | null>`(
  select case
           when root.assembly_version = ${GROUPABLE_ASSEMBLY}
            and ${PUBLISHED_GENERATION_IS_CURRENT}
           then root.group_revision
         end
    from ${sourceBundles} b
    join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
   where b.id = ${sourceDocuments.bundleId}
)`;

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
 * Для legacy-пакетов no-op: там группы нет, ревизия ничего не значит.
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
             updated_at = now()
        from root
       where sb.id = root.id
         and sb.assembly_version = ${GROUPABLE_ASSEMBLY}
      returning sb.id
    )
    update ${sourceDocuments} sd
       set updated_at = now(),
           version = sd.version + 1
      from ${sourceBundles} b, bumped
     where b.id = sd.bundle_id
       and coalesce(b.parent_bundle_id, b.id) = bumped.id
       and sd.is_technical = false
  `);
}
