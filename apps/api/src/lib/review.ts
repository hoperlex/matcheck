import type { PageId } from '@matcheck/contracts';
import { isAllowed } from './permissions/matrix.js';
import type { OverrideMap } from './permissions/matrix.js';

/**
 * Видимость отметки проверки качества (review_state/review_note/кто-когда) на
 * портале. Это внутренняя QC-кухня менеджмента: её видят только admin/manager/
 * monitor/observer. Для прочих ролей (contractor, inspector_kpp) и для анонимных
 * путей (публичная share-страница) review-поля обнуляются в DTO.
 *
 * По умолчанию (роль не передана / undefined) — СКРЫВАЕМ: безопасный дефолт,
 * чтобы новый путь построения DTO случайно не раскрыл review наружу.
 *
 * observer здесь потому, что список отвечает на вопрос «кому эта кухня в
 * принципе предназначена», а НЕ «у кого право есть». Право проверяет матрица
 * ниже (canSeeReviewInMatrix), и у наблюдателя дефолт пуст — значит поля
 * появятся ровно тогда, когда администратор выдаст ему «Проверять». Без записи
 * в этом списке выданная галочка работала бы наполовину: PATCH .../review
 * проходил бы, а DTO возвращал бы null, и человек не видел бы результат
 * собственной отметки.
 */
const REVIEW_VISIBLE_ROLES = new Set(['admin', 'manager', 'monitor', 'observer']);

export function canSeeReview(role: string | null | undefined): boolean {
  return role != null && REVIEW_VISIBLE_ROLES.has(role);
}

/**
 * Кто может СТАВИТЬ отметку проверки (PATCH .../review): те же роли-менеджмент.
 * Гейтинг эндпоинта делает app.authorize(...), это — для явных проверок в коде.
 */
export function canReview(role: string | null | undefined): boolean {
  return canSeeReview(role);
}

/** Минимум от FastifyInstance, нужный для сверки с матрицей. */
type PermissionsAware = {
  permissions?: { enforced: boolean; get(): Promise<OverrideMap> };
};

/**
 * Видимость review-полей С УЧЁТОМ матрицы прав.
 *
 * Список ролей выше отвечает на вопрос «кому эта кухня вообще предназначена», а
 * матрица — «не сняли ли администратором отметку у этой роли». Итог —
 * конъюнкция: снятая галочка «Проверять» обязана скрывать и сами поля, иначе
 * роль продолжала бы видеть чужие оценки качества, потеряв лишь кнопку.
 *
 * Расширить видимость эта функция не может: роли вне REVIEW_VISIBLE_ROLES не
 * получат поля, даже если галочка им выдана. Выдать review можно manager,
 * monitor и observer — все трое в списке, — но правило «только сужаем»
 * оставлено намеренно: DTO не место для расширения доступа.
 *
 * При выключенном enforcement и в окружениях без плагина прав (часть юнит-тестов
 * поднимает Fastify без него) поведение прежнее — как до появления матрицы. Для
 * observer это означает «видит поля»: сам маршрут ему в этом режиме всё равно
 * закрыт matrix-only хуком, так что раскрытия не происходит.
 */
export async function canSeeReviewInMatrix(
  app: PermissionsAware,
  role: string | null | undefined,
  page: PageId,
): Promise<boolean> {
  if (!canSeeReview(role)) return false;
  const permissions = app.permissions;
  if (!permissions?.enforced) return true;
  return isAllowed(await permissions.get(), role as never, page, 'review');
}
