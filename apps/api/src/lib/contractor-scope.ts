import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql as drSql } from 'drizzle-orm';
import {
  counterparties,
  customerCounterparties,
  deliveries,
  sourceDocuments,
} from '../db/schema.js';
import type { AuthUser } from '../plugins/auth.js';

// Скоупинг видимости по подрядчику (роль contractor). Аналог inspector_kpp→siteId,
// но по подрядчику: пользователь привязан к строке справочника
// customer_counterparties, которая разворачивается в операционные
// counterparties.id по нормализованному ИНН (один реальный подрядчик = один ИНН
// = несколько операционных строк-дублей). Тот же механизм, что у UI-фильтра
// «Подрядчик», поэтому область видимости роли и ручной фильтр дают один предикат.

/**
 * Directory-id (customer_counterparties) → операционные counterparties.id по
 * нормализованному ИНН. Пустой массив на входе или отсутствие совпадений по ИНН
 * → пустой результат (интерпретируется вызывающим как «ничего не видно»).
 * regexp_replace убирает всё, кроме цифр; пустой/нулевой ИНН отбрасывается,
 * чтобы разные контрагенты без ИНН не «склеились».
 */
export async function expandCustomerCounterpartyToOpIds(
  app: FastifyInstance,
  directoryIds: string[],
): Promise<string[]> {
  if (directoryIds.length === 0) return [];
  const rows = await app.db
    .select({ id: counterparties.id })
    .from(counterparties)
    .innerJoin(
      customerCounterparties,
      drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g')
          = regexp_replace(coalesce(${customerCounterparties.inn}, ''), '[^0-9]', '', 'g')`,
    )
    .where(
      and(
        inArray(customerCounterparties.id, directoryIds),
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') != ''`,
        drSql`regexp_replace(coalesce(${counterparties.inn}, ''), '[^0-9]', '', 'g') !~ '^0+$'`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Операционные counterparty-id, к которым привязан пользователь-подрядчик.
 * - null  → роль НЕ contractor: вызывающий пропускает скоупинг по подрядчику.
 * - []    → contractor без привязки (contractorCustomerId=null) ИЛИ его ИНН не
 *           совпал ни с одной операционной строкой: вызывающий пушит `false`
 *           (подрядчик видит пусто, как inspector без объекта).
 * - [...] → набор операционных id для фильтра.
 */
export async function resolveContractorOpIds(
  app: FastifyInstance,
  user: AuthUser | undefined,
): Promise<string[] | null> {
  if (!user || user.role !== 'contractor') return null;
  if (!user.contractorCustomerId) return [];
  return expandCustomerCounterpartyToOpIds(app, [user.contractorCustomerId]);
}

/**
 * Автоподставленный подрядчик правом доступа не является.
 *
 * recipient_source='auto_buyer' ставит воркер, вычитав ИНН покупателя из шапки
 * УПД, пришедшего с публичной страницы /uploads. Страница открыта всем: файл
 * недоверенный, и его содержимое не должно превращаться в область видимости —
 * иначе достаточно прислать УПД с чужим ИНН, чтобы его подрядчик увидел
 * поставщиков и суммы. Для менеджера подстановка полноценна (снимает «Черновик»,
 * видна в колонке), для RBAC — нет.
 *
 * Ограничение снимается, когда появятся именные ссылки загрузки: там подрядчик
 * будет свойством канала, а не содержимого файла.
 */

/**
 * Предикат видимости ДОКУМЕНТА для подрядчика: contractor_id ∈ opIds и получателя
 * проставил не резолвер. Вызывать только при непустом opIds — на пустом массиве
 * вызывающий пушит `false` (подрядчик видит пусто, как inspector без объекта).
 *
 * Существует, чтобы правило «auto_buyer не даёт доступа» жило в одном месте:
 * раньше условие писалось руками в пяти роутах source-documents.ts, и добавить
 * туда исключение построчно значило бы однажды его пропустить.
 */
export function sourceDocumentContractorPredicate(opIds: string[]) {
  return and(
    inArray(sourceDocuments.contractorId, opIds),
    drSql`${sourceDocuments.recipientSource} IS DISTINCT FROM 'auto_buyer'`,
  )!;
}

/**
 * Литерал `ARRAY['…','…']::uuid[]` для сравнений вида `= ANY(...)`.
 *
 * Подставлять JS-массив прямо в шаблон нельзя: drizzle разворачивает его в
 * список плейсхолдеров (`($1, $2)`), и Postgres получает не литерал массива, а
 * отдельные значения — запрос падает с «malformed array literal». В обычных
 * условиях выручает `inArray()`, но внутри EXISTS ниже колонка адресуется через
 * алиас `sd_c`, до которого билдер не достаёт, — там нужен именно этот литерал.
 */
function uuidArray(ids: string[]) {
  return drSql`ARRAY[${drSql.join(
    ids.map((id) => drSql`${id}`),
    drSql`, `,
  )}]::uuid[]`;
}

/**
 * То же правило для уже загруженной строки — детальный роут, скачивание
 * оригинала, PATCH. Держим рядом с SQL-предикатом, чтобы два представления
 * одного правила нельзя было развести по недосмотру.
 */
export function sourceDocumentVisibleToContractor(
  sd: { contractorId: string | null; recipientSource: string | null },
  opIds: string[] | null,
): boolean {
  if (!opIds || !sd.contractorId || !opIds.includes(sd.contractorId)) return false;
  return sd.recipientSource !== 'auto_buyer';
}

/**
 * Видит ли пользователь этот документ вообще.
 *
 * Правило одно на все маршруты документа — карточку, `/file`, `/file/raw` и
 * ссылку на дополнительный файл. Раньше оно было скопировано в каждый из них
 * слово в слово, и следующая правка ролей неминуемо разошлась бы с одной из
 * копий: маршрут со старой проверкой отдал бы файл документа, которого человек
 * не видит.
 *
 * Принимает УЖЕ ЗАГРУЖЕННУЮ строку: в карточке она всё равно выбирается, и
 * повторный запрос в БД был бы лишним.
 */
export async function sourceDocumentVisible(
  app: FastifyInstance,
  user: AuthUser | undefined,
  sd: {
    siteId: string | null;
    contractorId: string | null;
    recipientSource: string | null;
    isTechnical?: boolean | null;
  },
): Promise<boolean> {
  // Служебная запись пакета: держатель вложений на время разбора и промежуточный
  // документ сборки логических УПД. Списки и /sync её и так не отдают, но по
  // прямому id она открывалась — а до публикации это половина поставки, которую
  // никто не должен ни открыть, ни привязать к приёмке.
  if (sd.isTechnical) return false;
  // inspector_kpp видит только документы своего объекта.
  if (user?.role === 'inspector_kpp') {
    return !!user.siteId && sd.siteId === user.siteId;
  }
  // contractor видит только документы своего подрядчика — и только там, где
  // подрядчик проставлен человеком, а не автоподстановкой.
  if (user?.role === 'contractor') {
    const opIds = await resolveContractorOpIds(app, user);
    return sourceDocumentVisibleToContractor(sd, opIds);
  }
  return true;
}

/**
 * Наследующий предикат видимости приёмки для подрядчика: приёмка «его», если её
 * contractor_id ∈ opIds, ЛИБО у приёмки contractor_id пуст, но привязанный
 * документ (УПД) имеет contractor_id ∈ opIds. Повторяет UI-фильтр «Подрядчик»
 * (deliveries.ts). Вызывать только при непустом opIds.
 *
 * Ветки различаются намеренно. deliveries.contractor_id записан при сохранении
 * приёмки: форма подставляет его из УПД при гидратации, но нажимает «Сохранить»
 * авторизованный инспектор — это решение человека, и оно остаётся основанием
 * для доступа. Вторая ветка — молчаливое наследование из документа, и вот там
 * автоподстановка подтверждением не считается.
 */
export function deliveryContractorPredicate(
  opIds: string[],
  opts: { purpose: 'rbac' | 'ui-filter' } = { purpose: 'rbac' },
) {
  const ids = uuidArray(opIds);
  // Единственное различие двух режимов. Для RBAC автоподставленный подрядчик
  // основанием доступа не является, а для фильтра «Подрядчик» в списке — ещё
  // как: менеджер ищет все приёмки этого подрядчика, включая те, где значение
  // подставил резолвер. Дефолт — строгий: забытый аргумент сужает видимость,
  // а не расширяет.
  const inherited =
    opts.purpose === 'rbac'
      ? drSql` AND sd_c.recipient_source IS DISTINCT FROM 'auto_buyer'`
      : drSql``;
  return drSql`(
    ${deliveries.contractorId} = ANY(${ids})
    OR (
      ${deliveries.contractorId} IS NULL
      AND EXISTS (
        SELECT 1 FROM delivery_sources ds_c
        JOIN source_documents sd_c ON sd_c.id = ds_c.source_document_id
        WHERE ds_c.delivery_id = ${deliveries.id}
          AND sd_c.contractor_id = ANY(${ids})${inherited}
      )
    )
  )`;
}

/**
 * Видима ли конкретная приёмка подрядчику (для детального/файлового эндпоинта,
 * где предикат нельзя вшить в основной запрос). opIds — результат
 * resolveContractorOpIds; при пустом массиве всегда false.
 */
export async function deliveryVisibleToContractor(
  app: FastifyInstance,
  deliveryId: string,
  opIds: string[],
): Promise<boolean> {
  if (opIds.length === 0) return false;
  const [row] = await app.db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.id, deliveryId), deliveryContractorPredicate(opIds)))
    .limit(1);
  return !!row;
}
