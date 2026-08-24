/**
 * Что из документов вообще доезжает до планшета.
 *
 * Требование простое на словах — «на планшет попадает только обработанное» — но
 * `status = 'parsed'` его не выражает. Портал СВОИМИ РУКАМИ рисует такой
 * документ «Черновиком», если у него нет объекта, ожидаемой даты или получателя
 * (getDocumentDisplayStatus в контрактах). Отдать инспектору документ, который
 * менеджер видит черновиком, — значит дать принять машину, у которой даже
 * получатель не определён.
 *
 * Поэтому предикат один на все точки выдачи: дельта /sync, reconcile,
 * detail-fetch мобилы и проверка при создании приёмки/отгрузки. Разъехавшись,
 * они дают худший из возможных багов: документ виден в списке, но принять его
 * нельзя, либо наоборот — форма открылась, а сервер отказывает.
 *
 * Портала и админки это НЕ касается: они обязаны видеть скрытое, иначе кнопкой
 * «Принять как есть» некому будет воспользоваться.
 */
import { sql, type SQL } from 'drizzle-orm';
import { ingestEvents, sourceBundles, sourceDocuments } from '../../db/schema.js';
import { STUB_ERROR_CODES } from '@matcheck/contracts';
import { groupModeSites } from '../groups/group-mode.js';
import { assemblyServedRowSql } from './bundle-import-registry.js';
import { machineRootSql } from './document-group.js';
import { loadEnv } from '../../lib/env.js';

/**
 * Реквизиты, без которых документ на планшете бесполезен.
 *
 * Зеркало getDocumentDisplayStatus: получатель зависит от направления —
 * у outbound это внешний контрагент или наш МОЛ, у inbound — наш подрядчик или
 * МОЛ. Держать правило в двух местах плохо, но альтернатива хуже: тянуть
 * TypeScript-функцию в SQL нечем, а выдача обязана фильтроваться в базе, иначе
 * пагинация и tombstones считаются по разным множествам.
 */
const HAS_REQUIRED_FIELDS = sql`
  ${sourceDocuments.siteId} is not null
  and ${sourceDocuments.expectedDate} is not null
  and (
    case
      when ${sourceDocuments.direction} = 'outbound'
        then ${sourceDocuments.recipientId} is not null or ${sourceDocuments.recipientMolId} is not null
      -- У ПРИЁМКИ получатель не требуется. Инспектору на площадке важно, от
      -- кого груз и кому он адресован, — поставщик и грузополучатель приходят
      -- из самого документа. Подрядчик же внутренняя привязка затрат: её
      -- ставит менеджер, и ожидание этого держало поставку на портале, пока
      -- машина стоит под разгрузкой. Зеркало getDocumentDisplayStatus —
      -- разъехавшись, они дают худший из багов: на портале «Черновик», а
      -- инспектор документ уже принимает.
      else true
    end
  )
`;

/**
 * Машина не в промежуточном состоянии.
 *
 * Машина едет на планшет целиком или не едет вовсе — иначе инспектор оформит
 * рейс по половине бумаг. Но «целиком» не значит «пока менеджер не разберёт всё
 * до последнего файла»: держать грузовик под разгрузкой из-за нераспознанного
 * фото нельзя. Поэтому блокирует только то, что ЕЩЁ В РАБОТЕ и приедет само:
 *
 *   * документ в разборе (queued/processing) — но не дольше STALE_PARSE_MINUTES;
 *   * документ дошёл до parsed, но без реквизитов — на портале это «Черновик»,
 *     менеджер вот-вот заполнит;
 *   * файл принят, а документа по нему нет ВООБЩЕ — проверка по source_documents
 *     такого не видит, потому что проверять нечего;
 *   * поколение загрузки в переходе: комплект прошлой отправки вот-вот снесут.
 *
 * НЕ блокируют и намеренно: archived, дубликаты, заглушки «не распознано»,
 * parse_failed, partial_parse, validation_mismatch. Все они ждут ЧЕЛОВЕКА, а не
 * машины, и до его решения могут стоять сутками. Проверено на боевых данных
 * перед сменой правила: за всё время журнала ни один документ не стал видимым
 * ПОСЛЕ того, как по его машине создали приёмку (0 из 49), а переходы
 * «скрыт → виден» укладываются в среднем в 0,1 минуты — то есть «опоздавших»
 * документов, ради которых стоило бы держать машину, на практике не бывает.
 * Прежнее правило (блокирует всё, что не parsed и не archived) держало 17 машин
 * из-за их собственных дубликатов.
 *
 * Для документа без машины (почта, ЭДО, внутренняя загрузка) подзапрос не
 * применяется — там понятия «машина» нет, документ отвечает сам за себя.
 */

/**
 * Сколько документ может висеть в разборе, прежде чем перестанет держать машину.
 *
 * Разбор укладывается в доли минуты, получас — заведомый запас. Предел нужен не
 * для скорости, а против зависших заданий: на бою один документ простоял в
 * очереди 21 час и без предела погасил бы свою машину навсегда.
 */
const STALE_PARSE_MINUTES = 30;

function groupIsCompleteSql(): SQL {
  // Пока рубильник выключен — ровно прежнее правило, до последнего условия.
  // Это обещание «выкат ничего не меняет для инспекторов»: набор блокирующих
  // расширяется только вместе с новым определением машины.
  const rollout = loadEnv().GROUPS_ROLLOUT;
  const blockingSibling = rollout
    ? sql`(
           sibling.id is not null
           and sibling.status in ('queued', 'processing')
           and coalesce(sibling.queued_at, sibling.created_at)
               > now() - make_interval(mins => ${STALE_PARSE_MINUTES})
         )`
    : sql`(sibling.id is not null and sibling.status not in ('parsed', 'archived'))`;
  // Строка реестра, закрытая человеком, и строка без ключа в хранилище держат
  // машину только по старому правилу — см. пояснения выше.
  const registryGuard = rollout
    ? sql`and bi.input_s3_key is not null and bi.resolved_at is null`
    : sql``;
  const generationInTransit = rollout
    ? sql`
         -- поколение загрузки в переходе: реестр прошлой отправки ещё есть, а
         -- реестра новой ещё нет. Ровно в этом окне комплект выглядит целой
         -- машиной, хотя его вот-вот удалят (см. purgePreviousGeneration).
         or (
           member.active_upload_generation > 0
           and not exists (
             select 1 from bundle_import_items x
              where x.bundle_id = member.id
                and x.upload_generation = member.active_upload_generation
           )
           and exists (
             select 1 from bundle_import_items x
              where x.bundle_id = member.id
                and x.upload_generation < member.active_upload_generation
           )
         )`
    : sql``;
  return sql`
  not exists (
    select 1
      from ${sourceBundles} self
      join ${sourceBundles} root on root.id = coalesce(self.parent_bundle_id, self.id)
      join ${sourceBundles} member on coalesce(member.parent_bundle_id, member.id) = root.id
      left join ${sourceDocuments} sibling
             on sibling.bundle_id = member.id
            and sibling.is_technical = false
      left join bundle_import_items bi
             on bi.bundle_id = member.id
            and bi.upload_generation = member.active_upload_generation
            -- Под новым правилом машину НЕ держат две категории строк.
            -- Без ключа в хранилище (частичный сбой приёма): заглушку по такой
            -- строке не заводит никто — selectRowsWithoutDocument требует
            -- input_s3_key is not null, — то есть снять блокировку было нечем и
            -- машина гасла навсегда. Закрытая человеком (ручной разбор,
            -- удаление документа менеджером): вопрос по файлу уже решён, а без
            -- этого удаление лишней бумаги гасило бы всю машину.
            ${registryGuard}
     where self.id = ${sourceDocuments.bundleId}
       and ${machineRootSql('root')}
       and (
         -- документ ещё в работе: под новым правилом это только разбор, который
         -- не завис; под старым — всё, что не parsed и не archived.
         ${blockingSibling}
         or (
           sibling.id is not null
           and sibling.status = 'parsed'
           and (
             sibling.site_id is null
             or sibling.expected_date is null
             -- Тот же набор обязательных реквизитов, что и у HAS_REQUIRED_FIELDS
             -- выше: у приёмки подрядчик не требуется. Условия обязаны
             -- совпадать — иначе документ виден сам по себе, но держит свою же
             -- машину скрытой, и поставка не приедет никогда.
             or case
                  when sibling.direction = 'outbound'
                    then sibling.recipient_id is null and sibling.recipient_mol_id is null
                  else false
                end
           )
         )
         -- файл принят, а документа по нему нет
         or (
           bi.id is not null
           and bi.status not in ('skipped')
           and not exists (
             select 1
               from source_document_attachments a
               join source_documents d on d.id = a.source_document_id
              where a.s3_key = bi.input_s3_key
                and d.is_technical = false
           )
           -- Кроме файлов, которые обслужила сборка: она склеивает несколько
           -- входных файлов в ОДИН документ, и вложение остаётся только у
           -- одного из них. Без этого исключения собранная машина не доезжает
           -- до планшета вовсе — её держит строка второго файла комплекта.
           and not ${assemblyServedRowSql()}
         )
         ${generationInTransit}
       )
  )
`;
}

/**
 * Поставка с публичного портала отдаётся только собранной и опубликованной.
 *
 * Пакет, пришедший через `/uploads`, — это машина: несколько документов одного
 * рейса. Пока сборка не свела их в логическую поставку, `group_id` у них NULL,
 * и планшет нарисует столько карточек, сколько документов. Инспектор оформит
 * один рейс дважды, а остаток повиснет неоформленным — ровно та беда, ради
 * которой группы и заводились.
 *
 * Одной проверки комплектности (GROUP_IS_COMPLETE) для этого мало: она следит,
 * чтобы документы приехали ОДНОВРЕМЕННО, но не делает из них группу. Поэтому
 * до публикации публичный пакет не выдаётся вовсе.
 *
 * Почта, внутренняя загрузка и ЭДО правилом не затронуты: там понятия «машина»
 * нет, документ отвечает сам за себя.
 */
const PORTAL_PACKAGE_IS_PUBLISHED = sql`
  not exists (
    select 1
      from ${sourceBundles} pb
      join ${sourceBundles} proot on proot.id = coalesce(pb.parent_bundle_id, pb.id)
     where pb.id = ${sourceDocuments.bundleId}
       and exists (
         select 1 from ${ingestEvents} ie
          where ie.bundle_id = proot.id and ie.channel = 'public'
       )
       and not (
         proot.assembly_version = 'logical_v1'
         and proot.published_generation is not null
         and proot.published_generation = proot.active_upload_generation
       )
  )
`;

/**
 * Полный предикат «документ виден инспектору».
 *
 * Собирается из пяти частей, и каждая закрывает свой класс проблем:
 *   1. терминальный успешный статус;
 *   2. не служебная запись и не заглушка «не распознано»;
 *   3. реквизиты заполнены — иначе это черновик;
 *   4. группа целиком готова;
 *   5. поставка с портала собрана и опубликована — за флагом PORTAL_GROUPS_STRICT.
 *
 * Функция, а не константа: пятая часть зависит от переменной окружения, и
 * значение, зафиксированное при импорте модуля, нельзя было бы ни выключить на
 * работающем сервере, ни проверить тестом.
 */
export function mobileVisibleSourceDocumentSql(): SQL {
  const strictPortal = loadEnv().PORTAL_GROUPS_STRICT;
  return sql`(
    ${sourceDocuments.status} = 'parsed'
    and ${sourceDocuments.isTechnical} = false
    and coalesce(${sourceDocuments.parseErrorCode}, '') not in (${sql.join(
      STUB_ERROR_CODES.map((code) => sql`${code}`),
      sql`, `,
    )})
    and ${HAS_REQUIRED_FIELDS}
    and ${groupIsCompleteSql()}
    ${strictPortal ? sql`and ${PORTAL_PACKAGE_IS_PUBLISHED}` : sql``}
  )`;
}

/**
 * Предикат выдачи с учётом отсечки «только будущие загрузки».
 *
 * Документ из пачки, принятой ДО выката, идёт по ПРЕЖНЕМУ контракту: он уже
 * лежит на планшетах, инспектор с ним работал, часть таких документов оформлена.
 * Отфильтровав их задним числом, мы бы забрали у инспектора то, что он вчера
 * видел, — включая документы, по которым начаты приёмки.
 *
 * Документ вне машины (почта, ЭДО, ручной внос) при заданной отсечке тоже идёт
 * по прежнему контракту: у него нет пакета, а значит и даты приёма, по которой
 * можно решить «новый или старый».
 *
 * Без отсечки (GROUPS_ROLLOUT_SINCE пуст) — обычный предикат для всего.
 */
export function mobileVisibleWithinRolloutSql(): SQL {
  const since = loadEnv().GROUPS_ROLLOUT_SINCE;
  if (!since) return mobileVisibleSourceDocumentSql();
  return sql`(
    coalesce(
      (select root.created_at
         from ${sourceBundles} b
         join ${sourceBundles} root on root.id = coalesce(b.parent_bundle_id, b.id)
        where b.id = ${sourceDocuments.bundleId}),
      ${sourceDocuments.createdAt}
    ) < ${since.toISOString()}::timestamptz
    or ${mobileVisibleSourceDocumentSql()}
  )`;
}

/** Отрицание — для поиска документов, которые надо снять с планшета. */
export function mobileHiddenSourceDocumentSql(): SQL {
  return sql`(not ${mobileVisibleSourceDocumentSql()})`;
}

/**
 * Тот же предикат, но ограниченный охватом canary.
 *
 * Зачем отдельная форма. Инспектор привязан к объекту, и его объект проверяет
 * `resolveGroupMode` ещё до выборки. У менеджера и админа объекта нет вовсе —
 * `siteId` равен null, проверка пропускается, и предикат применялся ко ВСЕЙ
 * выдаче: документы объектов, которые в canary не входят, исчезали у менеджера,
 * хотя инспектор соседнего объекта продолжал их видеть. Охват зависел от роли
 * смотрящего, а не от объекта, — то есть canary протекал.
 *
 * Правило: документ вне списка объектов идёт по прежнему контракту, документ
 * внутри — через предикат видимости.
 *
 * @param userSiteId объект пользователя; не null означает, что охват уже
 *   проверен по нему и сужать выборку не нужно.
 */
export function mobileVisibleWithinCanarySql(userSiteId: string | null | undefined): SQL {
  if (userSiteId) return mobileVisibleSourceDocumentSql();
  const sites = groupModeSites();
  // null — режим включён на всех объектах (`*`), сужать нечего.
  if (sites === null) return mobileVisibleSourceDocumentSql();
  // Пустой список сюда не доходит: resolveGroupMode вернул бы enabled=false.
  if (sites.length === 0) return mobileVisibleSourceDocumentSql();
  // `is null` в первой ветке обязателен: документ без объекта не проходит
  // HAS_REQUIRED_FIELDS, и без явного пропуска NOT IN дал бы по нему NULL,
  // выбросив строку из выдачи менеджера вместе с прежним контрактом.
  //
  // Скобки у вызова в третьей ветке ОБЯЗАТЕЛЬНЫ. Без них в шаблон попадает сама
  // функция, а drizzle не видит в ней SQLWrapper (нет getSQL) и биндит её как
  // обычный параметр: в запрос уходит `or $N` со значением-функцией вместо
  // предиката. Ветка достижима только для менеджера и админа (siteId = null)
  // при непустом списке объектов, поэтому на бою не проявлялась.
  return sql`(
    ${sourceDocuments.siteId} is null
    or ${sourceDocuments.siteId} not in ${sites}
    or ${mobileVisibleSourceDocumentSql()}
  )`;
}
