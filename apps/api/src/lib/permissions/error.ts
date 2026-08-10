import type { PageAction, PageId } from '@matcheck/contracts';
import { HttpError } from '../http-error.js';

/**
 * Отказ по матрице прав: 403 permission_denied.
 *
 * Наследование от HttpError и собственный `name` — не косметика, а условие
 * работоспособности (см. lib/error-handler.ts): статус берётся только у
 * HttpError, а поле `error` ответа — из err.name. Обычный Error превратился
 * бы в `500 internal_error`, а на 5xx мобильный MutationProcessor делает
 * Backoff вместо Drop — очередь мутаций на планшете встала бы намертво.
 */
export class PermissionError extends HttpError {
  readonly page: PageId;
  readonly action: PageAction;

  constructor(page: PageId, action: PageAction) {
    super(403, 'Недостаточно прав для этого действия');
    this.name = 'permission_denied';
    this.page = page;
    this.action = action;
  }
}
