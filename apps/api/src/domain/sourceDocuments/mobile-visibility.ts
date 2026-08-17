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
 * Группа не в промежуточном состоянии.
 *
 * Машина едет на планшет целиком или не едет вовсе. Блокирует её что угодно из
 * перечисленного:
 *
 *   * документ группы не дошёл до parsed — он ещё в разборе или требует
 *     решения менеджера;
 *   * документ группы дошёл, но без реквизитов — то есть «Черновик»;
 *   * строка реестра активного поколения не имеет исхода — файл принят, а
 *     документа по нему ещё нет ВООБЩЕ. Это ключевой случай: проверка по
 *     source_documents его не видит, потому что проверять нечего.
 *
 * `archived` намеренно не блокирует: осознанно исключённый дубль или
 * сертификат не должен держать машину вечно.
 *
 * Для документа без группы (legacy-сборка, ЭДО, почта) подзапрос не
 * применяется — там понятия «машина» нет, документ отвечает сам за себя.
 */
const GROUP_IS_COMPLETE = sql`
  not exists (
    select 1
      from ${sourceBundles} self
      join ${sourceBundles} root on root.id = coalesce(self.parent_bundle_id, self.id)
      join ${sourceBundles} member on coalesce(member.parent_bundle_id, member.id) = root.id
      left join ${sourceDocuments} sibling
             on sibling.bundle_id = member.id
            and sibling.is_technical = false
      -- Условия «есть ключ S3» здесь НЕТ намеренно. Файл, не долетевший до
      -- хранилища, оставляет строку без ключа (частичный сбой приёма), и
      -- пробел в машине от этого не становится меньше: документа по такому
      -- файлу нет и быть не может, пока его не дозагрузят.
      left join bundle_import_items bi
             on bi.bundle_id = member.id
            and bi.upload_generation = member.active_upload_generation
     where self.id = ${sourceDocuments.bundleId}
       and root.assembly_version = 'logical_v1'
       and (
         -- документ группы не готов. Статус archived сюда НЕ входит: осознанно
         -- исключённый дубль или сертификат не должен держать машину вечно.
         (sibling.id is not null and sibling.status not in ('parsed', 'archived'))
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
         )
       )
  )
`;

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
    and ${GROUP_IS_COMPLETE}
    ${strictPortal ? sql`and ${PORTAL_PACKAGE_IS_PUBLISHED}` : sql``}
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
  return sql`(
    ${sourceDocuments.siteId} is null
    or ${sourceDocuments.siteId} not in ${sites}
    or ${mobileVisibleSourceDocumentSql}
  )`;
}
