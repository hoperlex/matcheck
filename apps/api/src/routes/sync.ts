import type { FastifyInstance } from 'fastify';
import { desc, eq, getTableColumns, gte, or, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  SyncDeltaResponseSchema,
  ReconcileRequestSchema,
  ReconcileResponseSchema,
} from '@matcheck/contracts';
import {
  assets,
  counterparties,
  deliveries,
  deliveryItems,
  deliveryPhotos,
  deliverySources,
  entityDeletions,
  materials,
  responsiblePersons,
  shipments,
  shipmentItems,
  shipmentPhotos,
  shipmentSources,
  sites,
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  suppliers,
  units,
  users,
} from '../db/schema.js';
import {
  documentGroupIdSql,
  documentGroupRevisionSql,
} from '../domain/sourceDocuments/document-group.js';
import { notStubDocumentSql } from '../domain/sourceDocuments/stub-documents.js';
import {
  mobileVisibleWithinCanarySql,
  mobileVisibleWithinRolloutSql,
} from '../domain/sourceDocuments/mobile-visibility.js';
import { loadEnv } from '../lib/env.js';
import {
  SITE_TRANSFER_REASON,
  selectVisibilityTombstones,
} from '../domain/sourceDocuments/visibility-events.js';
import { parseCapabilities, resolveGroupMode } from '../domain/groups/group-mode.js';
import { hasDeltaChanges } from '../domain/sync/delta-changes.js';
import {
  decodePageToken,
  encodePageToken,
  trimPageToGroupBoundary,
} from '../domain/sourceDocuments/sync-page-token.js';

const QuerySchema = z.object({
  since: z.string().datetime().optional(),
  // Окно (в днях) для initial-sync: deliveries/shipments/sourceDocuments
  // отдаются за последние N дней. Default 90. При since != null игнорируется
  // (старые записи могли поменяться, дельта-sync их захватывает).
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  // Что умеет клиент, список через запятую. Сейчас распознаётся
  // `source_groups_v1` — поддержка группового протокола: typed-конфликты и
  // черновики, переживающие отказ сервера.
  //
  // Отсутствие параметра = старая сборка. Такой клиент получает прежний
  // контракт при любых серверных флагах: 409, которого он не понимает, для него
  // превращается в заблокированную сущность без объяснения инспектору.
  capabilities: z.string().optional(),
  // Позиция внутри снимка при листании документов. Непрозрачен для клиента.
  //
  // Без него листание было сломано: получив полную страницу, клиент двигал
  // курсор на серверный `cursor`, и всё, что старше последней отданной строки,
  // во вторую страницу уже не попадало — хвост дельты исчезал.
  //
  // Работает только вместе с capability: старый клиент токена не шлёт и получает
  // прежнее поведение.
  pageToken: z.string().optional(),
});

// Запас на clock skew между app-сервером и БД + на видимость только что
// закоммиченных записей. Курсор дельты сдвигаем на него назад, чтобы
// пограничные записи гарантированно попали в следующую дельту. Повтор
// безвреден — клиент применяет дельту идемпотентно (saveAggregate по id).
//
// Тридцать секунд ВМЕСТО трёх — но только вместе с новой моделью машины. Окно
// обязано превышать предельную длительность транзакции, которая пишет события
// видимости: событие помечается statement_timestamp(), а становится ВИДИМЫМ
// только после коммита. Транзакция, начавшая писать событие до выдачи курсора и
// закоммитившая после, иначе потеряла бы его навсегда — для метки удаления это
// документ, застрявший на планшете до переустановки.
//
// Под рубильником, а не всегда: пока метки не выдаются, расширять окно незачем,
// а лишний хвост дельты — это трафик на всех планшетах. Повтор строк сам по себе
// безвреден, клиент применяет дельту идемпотентно.
const SYNC_CURSOR_SAFETY_MS = 3000;
const SYNC_CURSOR_SAFETY_ROLLOUT_MS = 30_000;

// Размер страницы документов в групповом режиме.
//
// Меньше прежней тысячи намеренно: страница теперь может быть расширена до
// границы машины, а предикат видимости считает групповую полноту коррелированным
// подзапросом. Пятьсот строк — компромисс между числом round-trip'ов и временем
// одного запроса на активном объекте.
const SD_PAGE_LIMIT = 500;

export async function syncRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/sync',
    {
      // contractor — web-only read-only: sync (офлайн-пакет мобилки) ему не
      // нужен и без скоупа отдал бы широкий набор данных. Закрываем (403).
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: { querystring: QuerySchema, response: { 200: SyncDeltaResponseSchema } },
    },
    async (req) => {
      // Замер длительности запроса.
      //
      // Полевой прогон 25.08: планшет тратил на ПУСТУЮ дельту 8–14 секунд
      // (`cycle pull: 12247мс … del=0 ship=0 sd=0` в логе клиента), и по
      // клиентским цифрам нельзя разделить сеть и сервер. Обработчик всегда
      // выполняет полтора десятка SELECT'ов независимо от того, есть изменения
      // или нет, а планшеты опрашивают его на каждое чужое SSE-событие —
      // поэтому цена холостого запроса решает, куда вкладываться дальше.
      const handlerStartedAt = Date.now();
      // Курсор дельты фиксируем СЕЙЧАС, ДО SELECT'ов (минус буфер), а не
      // new Date() в КОНЦЕ ответа. Раньше cursor=now в конце создавал гонку:
      // запись, появившаяся между SELECT'ами и концом запроса, не попадала
      // ни в текущий ответ, ни в будущие дельты (since уезжал за её
      // updated_at) — и становилась видна только после logout/login
      // (initial-sync). Фиксация момента до выборок закрывает гонку.
      const syncStartedAt = new Date(
        Date.now() -
          (loadEnv().GROUPS_ROLLOUT ? SYNC_CURSOR_SAFETY_ROLLOUT_MS : SYNC_CURSOR_SAFETY_MS),
      );
      const since = req.query.since ? new Date(req.query.since) : null;
      const capabilities = parseCapabilities(req.query.capabilities);
      const windowDays = req.query.windowDays ?? 90;
      // effectiveSince — для deliveries/shipments/sourceDocuments:
      //  - при дельта-sync (since != null): since;
      //  - при initial-sync (since == null): now - windowDays days.
      // Справочники (counterparties/materials/sites/statuses) окно не применяют —
      // они полностью нужны клиенту независимо от дат.
      const effectiveSince = since ?? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      const inspectorOnly = req.user?.role === 'inspector_kpp';
      const userSiteId = req.user?.siteId ?? null;

      // Инспектор без привязки к объекту не должен видеть никаких данных —
      // это явная ошибка конфигурации, а не "доступ ко всему".
      if (inspectorOnly && !userSiteId) {
        const now = new Date().toISOString();
        req.log.info(
          { elapsedMs: Date.now() - handlerStartedAt, reason: 'no_site' },
          'sync delta',
        );
        return {
          cursor: syncStartedAt.toISOString(),
          serverNow: now,
          counterparties: [],
          materials: [],
          responsiblePersons: [],
          assets: [],
          sites: [],
          statuses: [],
          units: [],
          sourceDocuments: [],
          deliveries: [],
          shipments: [],
          deletedIds: {
            deliveries: [],
            shipments: [],
            sourceDocuments: [],
            responsiblePersons: [],
            assets: [],
          },
        };
      }

      // Быстрый холостой путь: если с момента `since` не изменилось ничего, что
      // эта ручка вообще отдаёт, — отвечаем сразу, не выполняя ~40 запросов.
      //
      // Только для дельты и только вне обхода страниц. Продолжение уже начатого
      // снимка пропускать нельзя ни при каких условиях: клиент двигает курсор
      // лишь после ПОСЛЕДНЕЙ страницы, и «пустой» ответ в середине обхода
      // оборвал бы его на полпути. Initial-sync (since == null) тоже идёт
      // полным путём — там всегда есть что отдать.
      //
      // Справочники статусов и единиц отдаём и здесь, как раньше. Они крошечные
      // (десятки строк), а приходят в КАЖДОМ ответе без дельта-фильтра — это
      // свойство, на которое клиент вправе рассчитывать: планшет, потерявший
      // справочник, восстанавливает его следующей же синхронизацией. Отдай мы
      // тут пустые массивы, восстановить его стало бы нечем.
      if (since !== null && !req.query.pageToken) {
        const changed = await hasDeltaChanges(app.db, { since, siteId: userSiteId });
        if (!changed) {
          const statusRowsFast = await app.db.select().from(statuses);
          const unitRowsFast = await app.db.select().from(units);
          req.log.info(
            {
              elapsedMs: Date.now() - handlerStartedAt,
              role: req.user?.role ?? null,
              siteId: userSiteId,
              fastEmpty: true,
            },
            'sync delta',
          );
          return {
            cursor: syncStartedAt.toISOString(),
            nextPageToken: null,
            serverNow: new Date().toISOString(),
            counterparties: [],
            materials: [],
            responsiblePersons: [],
            assets: [],
            sites: [],
            statuses: statusRowsFast.map((st) => ({
              id: st.id,
              entityType: st.entityType,
              code: st.code,
              label: st.label,
              color: st.color,
              sortOrder: st.sortOrder,
            })),
            units: unitRowsFast.map((u) => ({
              id: u.id,
              code: u.code,
              name: u.name,
              okeiCode: u.okeiCode,
              isActive: u.isActive,
              createdAt: u.createdAt.toISOString(),
              updatedAt: u.updatedAt.toISOString(),
            })),
            sourceDocuments: [],
            deliveries: [],
            shipments: [],
            deletedIds: {
              deliveries: [],
              shipments: [],
              sourceDocuments: [],
              responsiblePersons: [],
              assets: [],
            },
          };
        }
      }

      const cpRows = await app.db
        .select()
        .from(counterparties)
        .where(since ? gte(counterparties.updatedAt, since) : undefined)
        .orderBy(desc(counterparties.updatedAt))
        .limit(500);
      const matRows = await app.db
        .select()
        .from(materials)
        .where(since ? gte(materials.updatedAt, since) : undefined)
        .orderBy(desc(materials.updatedAt))
        .limit(500);
      const siteRows = await app.db
        .select()
        .from(sites)
        .where(since ? gte(sites.updatedAt, since) : undefined)
        .orderBy(desc(sites.updatedAt))
        .limit(500);
      // Статусы (entity_type='delivery'|'shipment'|…) клиент использует для UI:
      // лейбл, цвет, sortOrder. Меняются редко — отдаём всегда без фильтра.
      const statusRows = await app.db
        .select()
        .from(statuses)
        .orderBy(statuses.entityType, statuses.sortOrder);

      // Единицы измерения — справочник для дропдауна «Ед.» в модалке
      // материалов на мобиле. Отдаём активные, отсортированные по name —
      // мобильный клиент может рендерить как есть. См. таблицу units и
      // /api/v1/units. Дельта-фильтр не нужен: справочник ~20 строк,
      // отдаём всегда полностью.
      const unitRows = await app.db
        .select()
        .from(units)
        .where(eq(units.isActive, true))
        .orderBy(units.name);

      // Источниковые документы: для inspector_kpp фильтруем только по siteId.
      // Раньше тут был дополнительный фильтр not_exists (отдавать только не
      // привязанные УПД), но он ломал зеркало «портал ↔ мобила»: после
      // привязки УПД к приёмке на портале её `updated_at` не менялся,
      // в дельту /sync она не попадала, и Inbox инспектора залипал
      // фантомами до logout/login. Теперь:
      //   1) При INSERT/DELETE в delivery_sources/shipment_sources сервер
      //      бампает source_documents.updated_at (см. domain/sourceDocuments/touch.ts).
      //   2) /sync отдаёт инспектору ВСЕ УПД сайта в окне.
      //   3) Мобила фильтрует Inbox локально по своему junction-кэшу
      //      (см. IntakeUpdSelectViewModel — фильтр attachedIds), который
      //      синхронизируется через deliveries[].sourceDocumentIds.
      // Limit поднят до 1000 — на активном сайте инспектор после долгого
      // оффлайна может получить большую дельту, 200 обрезало бы важное.
      // Техническая запись пакета (kind='transport_waybill', status='queued')
      // живёт от загрузки документов до разбора и удаляется воркером. Инспектору
      // она не нужна и раньше уезжала на планшет, где висела фантомом до
      // logout/login. Фильтр по флагу, а не по kind: у реальных ТН тот же kind.
      const sdWhereParts = [
        gte(sourceDocuments.updatedAt, effectiveSince),
        eq(sourceDocuments.isTechnical, false),
        // Документы-заглушки (файл принят, распознать не удалось: тип не
        // определён, накладная не читается, сертификат, технический сбой)
        // существуют только ради того, чтобы файл не исчез из виду у менеджера.
        // Реквизитов в них нет, принять по ним нечего, а мобильный список
        // приёмки отбирает документы по объекту и дате поставки, без оглядки на
        // статус, — на планшете КПП такие строки просто засорили бы «Сегодня».
        // Разобранный вручную документ приедет обычной дельтой: код ошибки
        // очищается, updated_at бампается.
        notStubDocumentSql(),
      ];
      if (inspectorOnly && userSiteId) {
        sdWhereParts.push(eq(sourceDocuments.siteId, userSiteId));
      }
      // Групповой режим: на планшет уезжает только ОБРАБОТАННОЕ.
      //
      // `notStubDocumentSql` фильтрует заглушки, но пропускает и documents в
      // needs_resolution с расхождением сумм, и parsed без объекта или
      // получателя — те самые, что портал рисует «Черновиком». Инспектор не
      // должен принимать машину, у которой даже получатель не определён.
      //
      // Предикат НЕ зависит от capability клиента: «на планшет едет только
      // обработанное» — базовое правило выдачи, а не часть групповой механики.
      // Пока оно висело на том же рубильнике, что и группы, инспекторы получали
      // дубликаты и неразобранные документы: за две недели 87 штук, из них 40
      // дубликатов. Старому клиенту фильтр безразличен — он просто получает
      // меньше строк, а не другой контракт.
      //
      // Только инспектору. `/sync` тянет и веб-портал под ролями admin/manager
      // (apps/web/src/services/sync.ts), а им по контракту этого модуля положено
      // видеть скрытое — иначе кнопкой «Принять как есть» некому пользоваться.
      const groupMode = resolveGroupMode({ siteId: userSiteId, capabilities });
      const enforceVisibility = loadEnv().GROUPS_ROLLOUT && inspectorOnly;
      if (enforceVisibility) {
        sdWhereParts.push(mobileVisibleWithinRolloutSql());
      } else if (groupMode.enabled) {
        // Прежний путь под старым рубильником: сужение по объектам canary
        // обязательно, у менеджера siteId нет. См. mobileVisibleWithinCanarySql.
        sdWhereParts.push(mobileVisibleWithinCanarySql(userSiteId));
      }

      // Keyset-пагинация. Включается вместе с групповым режимом: старый клиент
      // токена не шлёт и получает прежнее поведение — одна страница на 1000.
      const pageToken = groupMode.enabled ? decodePageToken(req.query.pageToken) : null;
      // Снимок фиксируется первой страницей и дальше не меняется: иначе записи,
      // изменившиеся во время листания, сдвигали бы границы страниц.
      const snapshotAt = pageToken ? new Date(pageToken.snapshot) : syncStartedAt;
      if (pageToken) {
        // Позиция внутри снимка. Пара (updated_at, id), а не один updated_at: у
        // пачки, разобранной одним заданием, время совпадает до миллисекунды, и
        // по одному полю строки перескакивали бы.
        sdWhereParts.push(
          drSql`(${sourceDocuments.updatedAt}, ${sourceDocuments.id}) <
                (${pageToken.updatedAt}::timestamptz, ${pageToken.id}::uuid)`,
        );
      }
      if (groupMode.enabled) {
        // Верхняя граница снимка: всё, что появилось после начала листания,
        // приедет следующей дельтой, а не разорвёт текущую.
        sdWhereParts.push(drSql`${sourceDocuments.updatedAt} <= ${snapshotAt.toISOString()}::timestamptz`);
      }

      // getTableColumns вместо голого .select(): нужны все колонки документа
      // ПЛЮС два вычисляемых поля группы. Перечислять полсотни колонок руками
      // ради этого — верный способ потерять одну при следующей миграции.
      //
      // Порядок с тай-брейком по id обязателен для keyset: без него две строки с
      // одинаковым updated_at могли бы поменяться местами между страницами, и
      // одна из них потерялась бы, а другая приехала дважды.
      const sdFetched = await app.db
        .select({
          ...getTableColumns(sourceDocuments),
          groupId: documentGroupIdSql(),
          groupRevision: documentGroupRevisionSql(),
        })
        .from(sourceDocuments)
        .where(drAnd(...sdWhereParts))
        .orderBy(desc(sourceDocuments.updatedAt), desc(sourceDocuments.id))
        // +1 строка, чтобы отличить «страница кончилась» от «есть продолжение»,
        // не делая второй запрос.
        .limit(groupMode.enabled ? SD_PAGE_LIMIT + 1 : 1000);

      // Машина не режется границей страницы: половина документов на планшете —
      // это неполный состав материалов и вечное «состав изменился» на форме.
      const { page: sdRows, hasMore } = groupMode.enabled
        ? trimPageToGroupBoundary(sdFetched, SD_PAGE_LIMIT)
        : { page: sdFetched, hasMore: false };

      const lastRow = sdRows[sdRows.length - 1];
      const nextPageToken =
        hasMore && lastRow
          ? encodePageToken({
              snapshot: snapshotAt.toISOString(),
              updatedAt: lastRow.updatedAt.toISOString(),
              id: lastRow.id,
            })
          : null;

      const sdIds = sdRows.map((r) => r.id);
      const sdItemRows = sdIds.length
        ? await app.db
            .select()
            .from(sourceDocumentItems)
            .where(sql_in(sourceDocumentItems.sourceDocumentId, sdIds))
        : [];
      const sdAttachRows = sdIds.length
        ? await app.db
            .select()
            .from(sourceDocumentAttachments)
            .where(sql_in(sourceDocumentAttachments.sourceDocumentId, sdIds))
        : [];

      // Контакт автора УПД — нужен мобильному клиенту для кнопки звонка
      // в шапке списка материалов на 1 Этапе. Один SELECT по уникальным
      // userId'ам, чтобы не делать N+1. EDO/mail-полученные УПД имеют
      // createdByUserId = null — пропускаются.
      const sdCreatorIds = Array.from(
        new Set(sdRows.map((r) => r.createdByUserId).filter((v): v is string => !!v)),
      );
      const sdCreators = sdCreatorIds.length
        ? await app.db
            .select({ id: users.id, email: users.email, phone: users.phone })
            .from(users)
            .where(sql_in(users.id, sdCreatorIds))
        : [];
      const sdCreatorById = new Map(sdCreators.map((u) => [u.id, u]));

      // Имена сторон УПД для отображения на мобиле в списке выбора УПД:
      // поставщик — заголовок группы, грузополучатель — строка под номером
      // документа (см. IntakeUpdSelectScreen.kt / DispatchUpdSelectScreen.kt).
      // Подрядчик мобиле больше не показывается, но имя отдаём: он один на
      // объект, и убирать поле из ответа ради этого не стоит.
      //
      // Логика точно как в /source-documents list ([source-documents.ts:527]):
      //   supplierName = COALESCE(suppliers.name, counterparties.name)
      // где suppliers — справочник «Поставщики» (JOIN по supplier_directory_id,
      // основной путь для всех современных УПД), counterparties — legacy
      // operational таблица (JOIN по supplier_id, fallback для исторических
      // УПД до миграции 0064). contractorName = counterparties.name по
      // contractor_id. Никаких JOIN'ов в основном запросе sdRows — отдельные
      // SELECT'ы по уникальным UUID'ам: дешевле для drizzle, не меняет тип
      // sdRows, легко откатить.
      const sdSupplierDirIds = Array.from(
        new Set(
          sdRows.map((r) => r.supplierDirectoryId).filter((v): v is string => !!v),
        ),
      );
      const sdSupplierIds = Array.from(
        new Set(sdRows.map((r) => r.supplierId).filter((v): v is string => !!v)),
      );
      const sdContractorIds = Array.from(
        new Set(sdRows.map((r) => r.contractorId).filter((v): v is string => !!v)),
      );
      // Грузополучатель (графа 4). В проде consignee_id не заполнен ни разу —
      // графу 4 печатают без ИНН, связать её не с чем, — но резолвим по нему
      // так же, как веб, чтобы поведение совпадало, когда связь всё-таки есть.
      const sdConsigneeIds = Array.from(
        new Set(sdRows.map((r) => r.consigneeId).filter((v): v is string => !!v)),
      );
      // Покупатель (графа 6). Планшет показывает его в списке выбора УПД, когда
      // графа 4 не распозналась: подрядчика там не показывают вовсе — на
      // портале он скрыт из таблиц документов.
      const sdBuyerIds = Array.from(
        new Set(sdRows.map((r) => r.buyerId).filter((v): v is string => !!v)),
      );
      // Справочник «Поставщики» (suppliers, не путать с counterparties).
      const supplierDirRows = sdSupplierDirIds.length
        ? await app.db
            .select({ id: suppliers.id, name: suppliers.name })
            .from(suppliers)
            .where(sql_in(suppliers.id, sdSupplierDirIds))
        : [];
      const supplierDirById = new Map(supplierDirRows.map((r) => [r.id, r.name]));
      // Один SELECT на counterparties по объединённому списку — supplier-id
      // (legacy fallback COALESCE), contractor-id (основной источник) и
      // consignee-id (fallback для графы 4).
      const cpLookupIds = Array.from(
        new Set([...sdSupplierIds, ...sdContractorIds, ...sdConsigneeIds, ...sdBuyerIds]),
      );
      const cpLookupRows = cpLookupIds.length
        ? await app.db
            .select({ id: counterparties.id, name: counterparties.name })
            .from(counterparties)
            .where(sql_in(counterparties.id, cpLookupIds))
        : [];
      const cpNameById = new Map(cpLookupRows.map((r) => [r.id, r.name]));

      // Инспектор видит всё в рамках своего объекта (включая записи других
      // инспекторов на том же siteId) — синхронизировано с GET /deliveries,
      // см. коммит 1833b9d. До этого фильтр был по inspectorId.
      //
      // Окно: при дельта-sync — строго updated_at >= since. При initial-sync
      // дополнительно отдаём НЕЗАВЕРШЁННЫЕ приёмки (`filled` — ожидают 2 Этапа)
      // любого возраста: их список на мобиле не ограничен датой, и после
      // очистки базы (смена аккаунта/объекта) старая незакрытая приёмка иначе
      // не приехала бы вовсе. Расширять это на дельту нельзя — клиент листает,
      // пока ответ «длинный», и такие записи возвращались бы бесконечно.
      const deliveryWindow =
        since === null
          ? or(gte(deliveries.updatedAt, effectiveSince), eq(statuses.code, 'filled'))!
          : gte(deliveries.updatedAt, effectiveSince);
      const dRowsJoined = await app.db
        .select({ d: deliveries, s: statuses, molEmail: users.email })
        .from(deliveries)
        .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
        .leftJoin(users, eq(deliveries.confirmedByMolUserId, users.id))
        .where(
          inspectorOnly && userSiteId
            ? eqAnd(deliveries.siteId, userSiteId, deliveryWindow)
            : deliveryWindow,
        )
        .orderBy(desc(deliveries.updatedAt))
        .limit(500);
      const dRows = dRowsJoined.map((r) => ({ ...r.d, _status: r.s, _molEmail: r.molEmail }));
      const dIds = dRows.map((r) => r.id);

      // Для парных приёмок (transfer) подтягиваем плоско дату отгрузки и
      // объект-источник из связанного shipment + sites — это то, что показывает
      // KppPage в шапке вместо «УПД №…».
      const srcShipmentIds = dRows
        .map((d) => d.sourceShipmentId)
        .filter((id): id is string => id !== null);
      const srcShipmentRows = srcShipmentIds.length
        ? await app.db
            .select({
              id: shipments.id,
              shippedAt: shipments.shippedAt,
              siteId: shipments.siteId,
              siteCode: sites.code,
            })
            .from(shipments)
            .leftJoin(sites, eq(shipments.siteId, sites.id))
            .where(sql_in(shipments.id, srcShipmentIds))
        : [];
      const srcShipmentById = new Map<
        string,
        { shippedAt: Date | null; siteId: string; siteCode: string | null }
      >();
      for (const r of srcShipmentRows) {
        srcShipmentById.set(r.id, {
          shippedAt: r.shippedAt,
          siteId: r.siteId,
          siteCode: r.siteCode,
        });
      }

      const dItems = dIds.length
        ? await app.db.select().from(deliveryItems).where(sql_in(deliveryItems.deliveryId, dIds))
        : [];
      const dPhotos = dIds.length
        ? await app.db.select().from(deliveryPhotos).where(sql_in(deliveryPhotos.deliveryId, dIds))
        : [];
      const dSources = dIds.length
        ? await app.db
            .select()
            .from(deliverySources)
            .where(sql_in(deliverySources.deliveryId, dIds))
        : [];

      // ── Shipments (симметрично deliveries: видимость по siteId + окно) ──
      // Незавершённые отгрузки на initial-sync — `shipped` (ожидают 2 Этапа).
      const shipmentWindow =
        since === null
          ? or(gte(shipments.updatedAt, effectiveSince), eq(statuses.code, 'shipped'))!
          : gte(shipments.updatedAt, effectiveSince);
      const shRowsJoined = await app.db
        .select({ s: shipments, st: statuses, molEmail: users.email })
        .from(shipments)
        .innerJoin(statuses, eq(shipments.statusId, statuses.id))
        .leftJoin(users, eq(shipments.confirmedByMolUserId, users.id))
        .where(
          inspectorOnly && userSiteId
            ? eqAnd(shipments.siteId, userSiteId, shipmentWindow)
            : shipmentWindow,
        )
        .orderBy(desc(shipments.updatedAt))
        .limit(500);
      const shRows = shRowsJoined.map((r) => ({ ...r.s, _status: r.st, _molEmail: r.molEmail }));
      const shIds = shRows.map((r) => r.id);
      const shItems = shIds.length
        ? await app.db.select().from(shipmentItems).where(sql_in(shipmentItems.shipmentId, shIds))
        : [];
      const shPhotos = shIds.length
        ? await app.db
            .select()
            .from(shipmentPhotos)
            .where(sql_in(shipmentPhotos.shipmentId, shIds))
        : [];
      const shSources = shIds.length
        ? await app.db
            .select()
            .from(shipmentSources)
            .where(sql_in(shipmentSources.shipmentId, shIds))
        : [];

      // ── deletedIds (журнал hard-delete для офлайн-клиента) ──
      // Возвращаем только при дельта-sync (since != null) — на initial-sync
      // клиент стартует с нуля, история удалений не нужна. Для inspector_kpp
      // фильтр по siteId работает только для документов с siteId. Глобальные
      // справочники (МОЛ/ОС) удаляются без siteId — их клиент видит независимо
      // от роли.
      const deletedDeliveryIds: string[] = [];
      const deletedShipmentIds: string[] = [];
      const deletedSourceDocumentIds: string[] = [];
      const deletedResponsiblePersonIds: string[] = [];
      const deletedAssetIds: string[] = [];
      if (since) {
        // 1) Site-scoped удаления (deliveries/shipments/source_documents).
        const siteScoped = await app.db
          .select({ entityType: entityDeletions.entityType, entityId: entityDeletions.entityId })
          .from(entityDeletions)
          .where(
            inspectorOnly && userSiteId
              ? eqAnd(
                  entityDeletions.siteId,
                  userSiteId,
                  gte(entityDeletions.deletedAt, since),
                )
              : gte(entityDeletions.deletedAt, since),
          );
        for (const r of siteScoped) {
          if (r.entityType === 'delivery') deletedDeliveryIds.push(r.entityId);
          else if (r.entityType === 'shipment') deletedShipmentIds.push(r.entityId);
          else if (r.entityType === 'source_document')
            deletedSourceDocumentIds.push(r.entityId);
        }
        // 2) Глобальные справочники (siteId IS NULL) — независимо от роли.
        const globalDel = await app.db
          .select({ entityType: entityDeletions.entityType, entityId: entityDeletions.entityId })
          .from(entityDeletions)
          .where(
            drAnd(
              drSql`${entityDeletions.siteId} is null`,
              gte(entityDeletions.deletedAt, since),
            ),
          );
        for (const r of globalDel) {
          if (r.entityType === 'responsible_person')
            deletedResponsiblePersonIds.push(r.entityId);
          else if (r.entityType === 'asset') deletedAssetIds.push(r.entityId);
        }

        // 3) Скрытые документы — отдельная семантика от hard-delete.
        //
        // Документ может ПЕРЕСТАТЬ БЫТЬ ВИДИМЫМ, оставаясь в базе: соседний
        // документ машины ушёл на переразбор, в пачку добавился ещё не
        // разобранный файл, у документа сняли объект. entity_deletions про такое
        // не знает — там только физические удаления, — а дельта по updated_at не
        // покажет, потому что сам документ не менялся.
        //
        // Отдаём ровно тем, к кому применён фильтр видимости: иначе документ
        // исчезнет из выдачи, но останется лежать в памяти планшета навсегда —
        // дельта его больше не привезёт, а сверка удалять документы не умеет
        // (клиент игнорирует missingOnServer для source_documents). Capability
        // здесь ни при чём: поле deletedIds старая сборка понимает.
        //
        // С ВЫКЛЮЧЕННЫМ рубильником журнал отдаётся не целиком, а только по
        // переносам объекта. Причина: события пишет и воркер, независимо от
        // рубильника, — отдав их все, мы применили бы новое правило видимости
        // задним числом и разом сняли бы с планшетов документы, которые
        // инспектор по прежнему контракту видел. Перенос же объекта — не
        // групповая механика: карточка обязана исчезнуть с прежнего объекта в
        // любом режиме, иначе она живёт там вечно.
        const hidden = await selectVisibilityTombstones(app.db, {
          since,
          siteId: inspectorOnly ? userSiteId : null,
          ...(enforceVisibility || groupMode.enabled ? {} : { reasons: [SITE_TRANSFER_REASON] }),
        });
        deletedSourceDocumentIds.push(...hidden);
      }

      // Один id не может приехать и в документах, и в удалениях: клиент
      // применяет дельту в порядке «сначала записать, потом удалить», и такой
      // документ был бы стёрт сразу после записи. Схлопывание по последнему
      // событию делает selectVisibilityTombstones, здесь — страховка на случай
      // гонки между двумя выборками.
      const visibleIdSet = new Set(sdRows.map((r) => r.id));
      const dedupedDeletedSourceDocumentIds = [...new Set(deletedSourceDocumentIds)].filter(
        (id) => !visibleIdSet.has(id),
      );

      // Справочники МОЛ/ОС — дельта по updatedAt; для initial-sync (since=null)
      // отдаём все записи.
      const respPersonRows = await app.db
        .select()
        .from(responsiblePersons)
        .where(since ? gte(responsiblePersons.updatedAt, since) : undefined)
        .orderBy(desc(responsiblePersons.updatedAt))
        .limit(500);
      const assetRows = await app.db
        .select()
        .from(assets)
        .where(since ? gte(assets.updatedAt, since) : undefined)
        .orderBy(desc(assets.updatedAt))
        .limit(500);

      req.log.info(
        {
          elapsedMs: Date.now() - handlerStartedAt,
          role: req.user?.role ?? null,
          siteId: userSiteId,
          // initial — самый дорогой случай (окно 90 дней), его надо уметь
          // отделить от обычной дельты, иначе среднее ни о чём не говорит.
          initial: since === null,
          paged: pageToken !== null,
          hasNext: nextPageToken !== null,
          rows: {
            sd: sdRows.length,
            del: dRows.length,
            ship: shRows.length,
            cp: cpRows.length,
            mat: matRows.length,
            site: siteRows.length,
            rp: respPersonRows.length,
            asset: assetRows.length,
            status: statusRows.length,
            unit: unitRows.length,
            deleted:
              deletedDeliveryIds.length +
              deletedShipmentIds.length +
              dedupedDeletedSourceDocumentIds.length +
              deletedResponsiblePersonIds.length +
              deletedAssetIds.length,
          },
        },
        'sync delta',
      );

      return {
        // Курсор прохода — момент СНИМКА, а не now каждой страницы.
        //
        // snapshotAt заморожен первой страницей (см. выше), а syncStartedAt
        // пересчитывается на каждом запросе. Клиент коммитит курсор ПОСЛЕДНЕЙ
        // страницы (SyncPageWalk.decidePageStep на мобиле), и при
        // многостраничном обходе он объявлял применённым интервал
        // (snapshotAt, lastCursor], которого не получал: верхняя граница
        // снимка эти строки отсекла, а следующая дельта уйдёт уже от
        // lastCursor. Запись, изменившаяся во время обхода, не приезжала
        // НИКОГДА — ровно так теряется массовый bump updated_at (backfill,
        // переразбор), идущий параллельно листанию.
        //
        // На первой странице и вне группового режима snapshotAt ===
        // syncStartedAt, поэтому для одностраничного прохода не меняется
        // ничего. Повтор строк, изменившихся во время обхода, безвреден:
        // клиент применяет дельту идемпотентно.
        cursor: snapshotAt.toISOString(),
        nextPageToken,
        serverNow: new Date().toISOString(),
        deletedIds: {
          deliveries: deletedDeliveryIds,
          shipments: deletedShipmentIds,
          sourceDocuments: dedupedDeletedSourceDocumentIds,
          responsiblePersons: deletedResponsiblePersonIds,
          assets: deletedAssetIds,
        },
        counterparties: cpRows.map((c) => ({
          id: c.id,
          inn: c.inn,
          kpp: c.kpp,
          name: c.name,
          address: c.address,
          isSelf: c.isSelf,
          isSupplier: c.isSupplier,
          isCustomer: c.isCustomer,
          isContractor: c.isContractor,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
        materials: matRows.map((m) => ({
          id: m.id,
          code: m.code,
          name: m.name,
          unit: m.unit,
          createdAt: m.createdAt.toISOString(),
          updatedAt: m.updatedAt.toISOString(),
        })),
        responsiblePersons: respPersonRows.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          phone: r.phone,
          position: r.position,
          isActive: r.isActive,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        assets: assetRows.map((a) => ({
          id: a.id,
          code: a.code,
          name: a.name,
          unit: a.unit,
          isActive: a.isActive,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        })),
        sites: siteRows.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          fullName: s.fullName,
          address: s.address,
          isActive: s.isActive,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        statuses: statusRows.map((st) => ({
          id: st.id,
          entityType: st.entityType,
          code: st.code,
          label: st.label,
          color: st.color,
          sortOrder: st.sortOrder,
        })),
        units: unitRows.map((u) => ({
          id: u.id,
          code: u.code,
          name: u.name,
          okeiCode: u.okeiCode,
          isActive: u.isActive,
          createdAt: u.createdAt.toISOString(),
          updatedAt: u.updatedAt.toISOString(),
        })),
        sourceDocuments: sdRows.map((sd) => {
          const creator = sd.createdByUserId ? sdCreatorById.get(sd.createdByUserId) : null;
          // COALESCE-логика как в веб-портале (/source-documents list:527):
          //   supplierName = COALESCE(suppliers.name, counterparties.name)
          // Приоритет — справочник «Поставщики» (suppliers, JOIN по
          // supplier_directory_id — основной путь для всех современных УПД,
          // включая результаты LLM-парсинга PDF). Fallback — legacy
          // counterparties по supplier_id (исторические УПД до миграции 0064).
          const supplierName =
            (sd.supplierDirectoryId && supplierDirById.get(sd.supplierDirectoryId)) ||
            (sd.supplierId && cpNameById.get(sd.supplierId)) ||
            null;
          const contractorName =
            (sd.contractorId && cpNameById.get(sd.contractorId)) || null;
          // Грузополучатель (графа 4) — тем же COALESCE, что в основном DTO
          // (sdRow в routes/source-documents.ts) и в primarySourceDocument
          // (deliveries.ts:456). Именно ??, а не || как у соседей выше:
          // COALESCE отдаёт consignee_name_raw, даже если это пустая строка,
          // а || провалился бы в FK-ветку. Расхождение намеренное — поведение
          // supplierName/contractorName не трогаем.
          const consigneeName =
            sd.consigneeNameRaw ??
            (sd.consigneeId ? cpNameById.get(sd.consigneeId) ?? null : null);
          // Тем же COALESCE, что и грузополучатель.
          const buyerName =
            sd.buyerNameRaw ?? (sd.buyerId ? cpNameById.get(sd.buyerId) ?? null : null);
          return {
          id: sd.id,
          kind: sd.kind,
          direction: sd.direction,
          status: sd.status,
          supplierId: sd.supplierId,
          supplierName,
          recipientId: sd.recipientId,
          contractorId: sd.contractorId,
          contractorName,
          consigneeId: sd.consigneeId,
          consigneeName,
          buyerId: sd.buyerId,
          buyerName,
          recipientMolId: sd.recipientMolId,
          // Мобильному клиенту поле не нужно, но /sync собирает документы по той
          // же SourceDocumentDetailSchema, что и портал: пропущенное поле молча
          // разошлось бы с DTO при первом же ужесточении схемы.
          recipientSource: sd.recipientSource ?? null,
          siteId: sd.siteId,
          docNumber: sd.docNumber,
          docDate: sd.docDate?.toISOString().slice(0, 10) ?? null,
          totalSum: sd.totalSum,
          vatSum: sd.vatSum,
          expectedDate: sd.expectedDate?.toISOString().slice(0, 10) ?? null,
          origin: sd.origin,
          llmProviderId: sd.llmProviderId,
          llmConfidence: sd.llmConfidence,
          parsedAt: sd.parsedAt.toISOString(),
          queuedAt: sd.queuedAt?.toISOString() ?? null,
          processedAt: sd.processedAt?.toISOString() ?? null,
          parseErrorCode: (sd.parseErrorCode as
            | 'duplicate_upd'
            | 'validation_mismatch'
            | 'pdf_no_text'
            | 'parse_failed'
            | 'internal_error'
            | 'unrecognized_type'
            | null) ?? null,
          parseErrorDetails: sd.parseErrorDetails ?? null,
          originalFilename: sd.originalFilename,
          contentHash: sd.contentHash,
          jobAttempts: sd.jobAttempts,
          version: sd.version,
          createdAt: sd.createdAt.toISOString(),
          updatedAt: sd.updatedAt.toISOString(),
          validation: sd.validation ?? null,
          createdByUserId: sd.createdByUserId,
          createdByUserEmail: creator?.email ?? null,
          createdByUserPhone: creator?.phone ?? null,
          // Идентификатор «машины»: документы одного корневого пакета планшет
          // склеивает в одну карточку и одну приёмку. null для legacy-сборки и
          // для документов без пакета — там каждый документ сам себе группа.
          // См. domain/sourceDocuments/document-group.ts.
          groupId: sd.groupId,
          groupRevision: sd.groupRevision,
          items: sdItemRows
            .filter((i) => i.sourceDocumentId === sd.id)
            .map((i) => ({
              id: i.id,
              materialId: i.materialId,
              nameRaw: i.nameRaw,
              qty: i.qty,
              unit: i.unit,
              price: i.price,
              sum: i.sum,
              vatRate: i.vatRate,
              vatSum: i.vatSum,
              expectedDate: i.expectedDate?.toISOString().slice(0, 10) ?? null,
              lineNo: i.lineNo,
              volumeM3: i.volumeM3,
              massKg: i.massKg,
              volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
              groupName: i.groupName,
              inventoryNumber: i.inventoryNumber,
            })),
          attachments: sdAttachRows
            .filter((a) => a.sourceDocumentId === sd.id)
            .map((a) => ({
              id: a.id,
              s3Key: a.s3Key,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              role: a.role,
            })),
          };
        }),
        deliveries: dRows.map((d) => ({
          id: d.id,
          displayId: d.displayId,
          status: {
            id: d._status.id,
            entityType: d._status.entityType,
            code: d._status.code,
            label: d._status.label,
            color: d._status.color,
            sortOrder: d._status.sortOrder,
          },
          siteId: d.siteId,
          supplierId: d.supplierId,
          contractorId: d.contractorId,
          recipientMolId: d.recipientMolId,
          vehiclePlate: d.vehiclePlate,
          driverName: d.driverName,
          arrivedAt: d.arrivedAt?.toISOString() ?? null,
          inspectorId: d.inspectorId,
          comment: d.comment,
          inTransit: d.inTransit,
          isAssets: d.isAssets,
          confirmedByMolUserId: d.confirmedByMolUserId,
          confirmedByMolUserEmail: d._molEmail,
          confirmedByMolAt: d.confirmedByMolAt?.toISOString() ?? null,
          // Soft-delete: email автора пометки в sync не подтягиваем (опциональный
          // join усложнил бы запрос), офлайн-клиент покажет адрес как «—».
          pendingDeletionAt: d.pendingDeletionAt?.toISOString() ?? null,
          pendingDeletionByUserId: d.pendingDeletionByUserId,
          pendingDeletionByUserEmail: null,
          pendingDeletionReason: d.pendingDeletionReason,
          version: d.version,
          sourceDocumentIds: dSources
            .filter((s) => s.deliveryId === d.id)
            .map((s) => s.sourceDocumentId),
          sourceShipmentId: d.sourceShipmentId,
          sourceShipmentShippedAt:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.shippedAt : null)?.toISOString() ??
            null,
          sourceShipmentSiteId:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.siteId : null) ?? null,
          sourceShipmentSiteCode:
            (d.sourceShipmentId ? srcShipmentById.get(d.sourceShipmentId)?.siteCode : null) ?? null,
          items: dItems
            .filter((i) => i.deliveryId === d.id)
            .map((i) => ({
              id: i.id,
              // Происхождение позиции обязано доезжать до планшета: по нему
              // форма 1 Этапа понимает, чью строку убрать при изменении состава
              // машины, и по нему же строятся секции по документам на портале.
              // Схема помечает поле optional — молчаливый пропуск здесь не
              // упал бы на валидации, а просто обнулил бы атрибуцию в Room.
              sourceDocumentId: i.sourceDocumentId,
              sourceDocumentItemId: i.sourceDocumentItemId,
              itemKind: i.itemKind,
              materialId: i.materialId,
              assetId: i.assetId,
              inventoryNumber: i.inventoryNumber,
              serialNumber: i.serialNumber,
              nameRaw: i.nameRaw,
              qtyPlanned: i.qtyPlanned,
              qtyActual: i.qtyActual,
              unit: i.unit,
              comment: i.comment,
              lineNo: i.lineNo,
              volumeM3: i.volumeM3,
              massKg: i.massKg,
              price: i.price,
              vatRate: i.vatRate,
              vatSum: i.vatSum,
              volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
              groupName: i.groupName,
            })),
          photos: dPhotos
            .filter((p) => p.deliveryId === d.id)
            .map((p) => ({
              id: p.id,
              kind: p.kind,
              stage: p.stage,
              s3Key: p.s3Key,
              thumbS3Key: p.thumbS3Key,
              contentHash: p.contentHash,
              takenAt: p.takenAt.toISOString(),
              uploadedAt: p.uploadedAt?.toISOString() ?? null,
            })),
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
        shipments: shRows.map((s) => ({
          id: s.id,
          displayId: s.displayId,
          status: {
            id: s._status.id,
            entityType: s._status.entityType,
            code: s._status.code,
            label: s._status.label,
            color: s._status.color,
            sortOrder: s._status.sortOrder,
          },
          kind: s.kind,
          purpose: s.purpose,
          inTransit: s.inTransit,
          isAssets: s.isAssets,
          siteId: s.siteId,
          receiverCounterpartyId: s.receiverCounterpartyId,
          receiverMolId: s.receiverMolId,
          destSiteId: s.destSiteId,
          supplierId: s.supplierId,
          vehiclePlate: s.vehiclePlate,
          driverName: s.driverName,
          shippedAt: s.shippedAt?.toISOString() ?? null,
          inspectorId: s.inspectorId,
          comment: s.comment,
          confirmedByMolUserId: s.confirmedByMolUserId,
          confirmedByMolUserEmail: s._molEmail,
          confirmedByMolAt: s.confirmedByMolAt?.toISOString() ?? null,
          pendingDeletionAt: s.pendingDeletionAt?.toISOString() ?? null,
          pendingDeletionByUserId: s.pendingDeletionByUserId,
          pendingDeletionByUserEmail: null,
          pendingDeletionReason: s.pendingDeletionReason,
          version: s.version,
          sourceDocumentIds: shSources
            .filter((x) => x.shipmentId === s.id)
            .map((x) => x.sourceDocumentId),
          items: shItems
            .filter((i) => i.shipmentId === s.id)
            .map((i) => ({
              id: i.id,
              // Зеркало приёмки — см. комментарий выше.
              sourceDocumentId: i.sourceDocumentId,
              sourceDocumentItemId: i.sourceDocumentItemId,
              itemKind: i.itemKind,
              materialId: i.materialId,
              assetId: i.assetId,
              inventoryNumber: i.inventoryNumber,
              serialNumber: i.serialNumber,
              nameRaw: i.nameRaw,
              qtyPlanned: i.qtyPlanned,
              qtyActual: i.qtyActual,
              unit: i.unit,
              comment: i.comment,
              lineNo: i.lineNo,
              volumeM3: i.volumeM3,
              massKg: i.massKg,
              price: i.price,
              vatRate: i.vatRate,
              vatSum: i.vatSum,
              volumeConfidence: i.volumeConfidence as 'low' | 'medium' | 'high' | null,
              groupName: i.groupName,
            })),
          photos: shPhotos
            .filter((p) => p.shipmentId === s.id)
            .map((p) => ({
              id: p.id,
              kind: p.kind,
              stage: p.stage,
              s3Key: p.s3Key,
              thumbS3Key: p.thumbS3Key,
              contentHash: p.contentHash,
              takenAt: p.takenAt.toISOString(),
              uploadedAt: p.uploadedAt?.toISOString() ?? null,
            })),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
      };
    },
  );

  // Read-only сверка планшет ↔ сервер. Клиент шлёт лёгкий список своих локальных
  // записей (id + version), сервер отвечает расхождениями по объекту инспектора.
  // НИЧЕГО не пишет — только SELECT и сравнение. Подготовка под мобильный
  // фоновый reconcile (M4): missingOnClient → клиент докачает, staleOnClient →
  // обновит, missingOnServer → переотправит (push-потеря). Идемпотентность
  // переотправки — по client-UUID, дублей нет.
  app.post(
    '/api/v1/sync/reconcile',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: { body: ReconcileRequestSchema, response: { 200: ReconcileResponseSchema } },
    },
    async (req) => {
      const inspectorOnly = req.user?.role === 'inspector_kpp';
      const userSiteId = req.user?.siteId ?? null;
      // Тот же режим, что в дельте: reconcile обязан отбирать документы по
      // тому же правилу, иначе он вернёт скрытое обратно. Capability берём из
      // тела запроса — reconcile POST, query-параметров у него нет.
      const reconcileGroupMode = resolveGroupMode({
        siteId: req.user?.siteId ?? null,
        capabilities: parseCapabilities(req.body.capabilities),
      });
      const noSite = inspectorOnly && !userSiteId;
      // Окно ограничивает ТОЛЬКО missingOnClient/staleOnClient разумным объёмом
      // (то, что клиент и так должен иметь после initial-sync 90 дней).
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      type Cli = { id: string; version: number };
      const reconcile = (
        serverRows: { id: string; version: number; updatedAt: Date }[],
        clientItems: Cli[],
        existingIds: Set<string>,
      ) => {
        const clientMap = new Map(clientItems.map((c) => [c.id, c.version] as const));
        return {
          missingOnClient: serverRows
            .filter((r) => !clientMap.has(r.id))
            .map((r) => ({ id: r.id, version: r.version, updatedAt: r.updatedAt.toISOString() })),
          staleOnClient: serverRows
            .filter((r) => {
              const cv = clientMap.get(r.id);
              return cv !== undefined && r.version > cv;
            })
            .map((r) => ({ id: r.id, serverVersion: r.version })),
          // Существование присланных id проверяем ОТДЕЛЬНЫМ запросом без окна
          // (см. existingIdsFor). Раньше здесь сверялись с оконной выборкой, и
          // любая живая запись старше 90 дней объявлялась «пропавшей на
          // сервере» — клиент переотправлял её через M4b push-recovery.
          missingOnServer: clientItems.filter((c) => !existingIds.has(c.id)).map((c) => c.id),
        };
      };

      /**
       * Множество id, которые реально есть на сервере в зоне видимости
       * пользователя. Без временного окна; скоуп по объекту сохраняем — чужая
       * запись честно считается отсутствующей, клиент её переотправит и получит
       * 403 `foreign_site`, после чего удалит локально.
       */
      const existingIdsFor = async (
        fetchChunk: (chunk: string[]) => Promise<{ id: string }[]>,
        ids: string[],
      ): Promise<Set<string>> => {
        const found = new Set<string>();
        if (noSite) return found;
        for (let i = 0; i < ids.length; i += RECONCILE_ID_CHUNK) {
          const chunk = ids.slice(i, i + RECONCILE_ID_CHUNK);
          if (chunk.length === 0) continue;
          for (const row of await fetchChunk(chunk)) found.add(row.id);
        }
        return found;
      };

      // Окно 90 дней ПЛЮС все ожидающие 2 Этапа (`filled`) независимо от
      // возраста: список 2 Этапа на мобиле по дате не ограничен, и старая
      // незакрытая приёмка должна доезжать на любой планшет объекта. В /sync
      // это допустимо только на initial-sync (иначе клиент листает бесконечно),
      // а здесь безопасно — reconcile отдаёт плоский список id+version.
      const delOpenOrRecent = or(gte(deliveries.updatedAt, since), eq(statuses.code, 'filled'))!;
      const delRows = noSite
        ? []
        : await app.db
            .select({
              id: deliveries.id,
              version: deliveries.version,
              updatedAt: deliveries.updatedAt,
            })
            .from(deliveries)
            .innerJoin(statuses, eq(deliveries.statusId, statuses.id))
            .where(
              inspectorOnly && userSiteId
                ? eqAnd(deliveries.siteId, userSiteId, delOpenOrRecent)
                : delOpenOrRecent,
            );
      const shipOpenOrRecent = or(gte(shipments.updatedAt, since), eq(statuses.code, 'shipped'))!;
      const shipRows = noSite
        ? []
        : await app.db
            .select({ id: shipments.id, version: shipments.version, updatedAt: shipments.updatedAt })
            .from(shipments)
            .innerJoin(statuses, eq(shipments.statusId, statuses.id))
            .where(
              inspectorOnly && userSiteId
                ? eqAnd(shipments.siteId, userSiteId, shipOpenOrRecent)
                : shipOpenOrRecent,
            );
      const sdRows = noSite
        ? []
        : await app.db
            .select({
              id: sourceDocuments.id,
              version: sourceDocuments.version,
              updatedAt: sourceDocuments.updatedAt,
            })
            .from(sourceDocuments)
            .where(
              // Технические записи из сверки исключаем: клиент их не получает
              // (см. фильтр дельты), и без этого reconcile объявлял бы их
              // «отсутствующими на клиенте» на каждом проходе.
              //
              // Предикат видимости здесь ОБЯЗАТЕЛЕН и по той же причине. Дельта
              // скрыла документ и прислала tombstone, а reconcile через минуту
              // сверил бы version и вернул его обратно через detail-роут —
              // скрытие не продержалось бы до конца синхронизации. Оба места
              // обязаны отбирать по одному правилу.
              drAnd(
                ...[
                  gte(sourceDocuments.updatedAt, since),
                  eq(sourceDocuments.isTechnical, false),
                  ...(inspectorOnly && userSiteId
                    ? [eq(sourceDocuments.siteId, userSiteId)]
                    : []),
                  // Точно то же условие, что в дельте, и включается тем же
                  // рубильником. Разъедься они — сверка вернула бы скрытый
                  // документ в missingOnClient, клиент скачал бы его
                  // detail-маршрутом (там проверяется только доступ), и скрытие
                  // не пережило бы одну синхронизацию.
                  ...(loadEnv().GROUPS_ROLLOUT && inspectorOnly
                    ? [mobileVisibleWithinRolloutSql()]
                    : reconcileGroupMode.enabled
                      ? [mobileVisibleWithinCanarySql(userSiteId)]
                      : []),
                ],
              ),
            );

      const delExisting = await existingIdsFor(
        (chunk) =>
          app.db
            .select({ id: deliveries.id })
            .from(deliveries)
            .where(
              inspectorOnly && userSiteId
                ? eqAnd(deliveries.siteId, userSiteId, inArray(deliveries.id, chunk))
                : inArray(deliveries.id, chunk),
            ),
        req.body.deliveries.map((c) => c.id),
      );
      const shipExisting = await existingIdsFor(
        (chunk) =>
          app.db
            .select({ id: shipments.id })
            .from(shipments)
            .where(
              inspectorOnly && userSiteId
                ? eqAnd(shipments.siteId, userSiteId, inArray(shipments.id, chunk))
                : inArray(shipments.id, chunk),
            ),
        req.body.shipments.map((c) => c.id),
      );
      const sdExisting = await existingIdsFor(
        (chunk) =>
          app.db
            .select({ id: sourceDocuments.id })
            .from(sourceDocuments)
            .where(
              // Тоже без технических: для клиента их не существует, и он не
              // должен переотправлять их как «пропавшие на сервере».
              inspectorOnly && userSiteId
                ? drAnd(
                    eq(sourceDocuments.siteId, userSiteId),
                    inArray(sourceDocuments.id, chunk),
                    eq(sourceDocuments.isTechnical, false),
                  )
                : drAnd(
                    inArray(sourceDocuments.id, chunk),
                    eq(sourceDocuments.isTechnical, false),
                  ),
            ),
        req.body.sourceDocuments.map((c) => c.id),
      );

      return {
        serverNow: new Date().toISOString(),
        deliveries: reconcile(delRows, req.body.deliveries, delExisting),
        shipments: reconcile(shipRows, req.body.shipments, shipExisting),
        sourceDocuments: reconcile(sdRows, req.body.sourceDocuments, sdExisting),
      };
    },
  );
}

import { and as drAnd, inArray, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

function sql_in<T extends AnyPgColumn>(col: T, ids: string[]) {
  return inArray(col, ids);
}

/**
 * Размер пачки id в existence-запросе reconcile. Клиент может прислать до 5000
 * записей на тип (ReconcileRequestSchema), а в один IN всё это класть незачем —
 * бьём на пачки, чтобы план запроса оставался предсказуемым.
 */
const RECONCILE_ID_CHUNK = 1000;
function eqAnd<T extends AnyPgColumn>(col: T, val: string, more: SQL): SQL {
  return drAnd(eq(col, val), more)!;
}
