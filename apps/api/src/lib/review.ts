/**
 * Видимость отметки проверки качества (review_state/review_note/кто-когда) на
 * портале. Это внутренняя QC-кухня менеджмента: её видят только admin/manager/
 * monitor. Для прочих ролей (contractor, inspector_kpp) и для анонимных путей
 * (публичная share-страница) review-поля обнуляются в DTO.
 *
 * По умолчанию (роль не передана / undefined) — СКРЫВАЕМ: безопасный дефолт,
 * чтобы новый путь построения DTO случайно не раскрыл review наружу.
 */
const REVIEW_VISIBLE_ROLES = new Set(['admin', 'manager', 'monitor']);

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
