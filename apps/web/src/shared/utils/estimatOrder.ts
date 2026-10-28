import type { EstimatApprovalState, EstimatOrderSummary } from '@matcheck/contracts';

/**
 * Подписи и цвета заказов поставщикам из EstiMat — общие для чипа и блока
 * приёмки, окна подбора и вкладки «Заказы». Состояние согласования считает
 * approvalState() из контракта (сервер отдаёт его готовым), здесь только вид.
 */

export const ESTIMAT_STAGE_LABELS: Record<string, string> = {
  forming: 'Формируется',
  sourcing: 'Сбор предложений',
  approval: 'На согласовании',
  awarded: 'Поставщик выбран',
  recorded: 'Зафиксирован',
  cancel_pending: 'Отмена тендера',
  cancelled: 'Отменён',
  no_award: 'Аннулирован',
};

/** Неизвестную стадию (контракт расширяется) показываем как есть. */
export function stageLabel(stage: string): string {
  return ESTIMAT_STAGE_LABELS[stage] ?? stage;
}

export const APPROVAL_STATE_LABELS: Record<EstimatApprovalState, string> = {
  approved: 'Согласован',
  pending: 'Не согласован',
  not_required: 'Виза не требуется',
  cancelling: 'Отмена тендера',
  cancelled: 'Отменён',
  deleted: 'Удалён в EstiMat',
  unknown: 'Стадия неизвестна',
};

/** Цвет antd Tag по состоянию. */
export const APPROVAL_STATE_COLORS: Record<EstimatApprovalState, string> = {
  approved: 'green',
  not_required: 'green',
  pending: 'orange',
  cancelling: 'orange',
  cancelled: 'red',
  deleted: 'red',
  unknown: 'default',
};

/** Чем хуже состояние, тем больше число: чип красится по худшему из заказов. */
const SEVERITY: Record<EstimatApprovalState, number> = {
  approved: 0,
  not_required: 0,
  unknown: 1,
  pending: 2,
  cancelling: 2,
  cancelled: 3,
  deleted: 3,
};

export function worstApprovalState(states: readonly EstimatApprovalState[]): EstimatApprovalState | null {
  let worst: EstimatApprovalState | null = null;
  for (const s of states) if (worst === null || SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

const MSK_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const MSK_DATE = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Время из EstiMat приходит в UTC — людям показываем по Москве. */
export function formatMsk(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return (withTime ? MSK_DATE_TIME : MSK_DATE).format(d);
}

/**
 * Виза одной строкой: «согласован 22.10.2026, 15:40», «согласование снято
 * 23.10.2026» и т.д. Дата снятия — когда обход это заметил, а не момент в EstiMat.
 */
export function approvalText(
  order: Pick<EstimatOrderSummary, 'approvalState' | 'supplyApprovedAt' | 'lastApprovalRevokedAt'>,
): string {
  switch (order.approvalState) {
    case 'approved':
      return `согласован ${formatMsk(order.supplyApprovedAt)}`;
    case 'pending':
      return order.lastApprovalRevokedAt
        ? `согласование снято (замечено ${formatMsk(order.lastApprovalRevokedAt)})`
        : 'не согласован';
    case 'not_required':
      return 'виза не требуется (закупает подрядчик)';
    case 'cancelling':
      return 'отмена тендера';
    case 'cancelled':
      return 'отменён';
    case 'deleted':
      return 'удалён в EstiMat';
    case 'unknown':
      return 'стадия неизвестна';
  }
}

/** Подрядчики заказа одной строкой; у МОЛ — пометка. */
export function contractorsText(order: Pick<EstimatOrderSummary, 'contractors'>): string {
  if (order.contractors.length === 0) return '—';
  return order.contractors.map((c) => (c.type === 'mol' ? `${c.name} (МОЛ)` : c.name)).join(', ');
}
