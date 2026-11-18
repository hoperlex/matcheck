/**
 * Отметка «Диспетчер» у многих приёмок разом — строка группы и отмеченные
 * строки «Принятых» (POST /deliveries/bulk-dispatcher-check).
 *
 * Одна кнопка: пока у части подходящих приёмок отметки нет — ставит её им,
 * когда отмечены все — снимает. Уже стоящие отметки сервер не перезаписывает.
 */
import type { Delivery, DispatcherBulkCheckResponse } from '@matcheck/contracts';
import { deliveriesCount } from './deliveryGroupRows';

/** Гейт зрелости — как на сервере и в DispatcherCheckControl. */
const MATURE = new Set(['filled', 'confirmed_mol']);

export type DispatcherCounts = { checked: number; eligible: number };

export type DispatcherBulkPlan =
  | { block: string }
  | { block: null; mode: 'check' | 'uncheck'; count: number };

export function dispatcherBulkPlan({ checked, eligible }: DispatcherCounts): DispatcherBulkPlan {
  if (eligible <= 0) return { block: 'Нет оформленных приёмок — отметка диспетчера недоступна' };
  if (checked >= eligible) return { block: null, mode: 'uncheck', count: checked };
  return { block: null, mode: 'check', count: eligible - checked };
}

/** Счёт по строкам страницы (отмеченным галочками). */
export function dispatcherCountsOf(
  rows: readonly {
    status: Pick<Delivery['status'], 'code'>;
    pendingDeletionAt?: string | null;
    dispatcherCheckedAt?: string | null;
  }[],
): DispatcherCounts {
  const eligible = rows.filter((r) => !r.pendingDeletionAt && MATURE.has(r.status.code));
  return {
    eligible: eligible.length,
    checked: eligible.filter((r) => !!r.dispatcherCheckedAt).length,
  };
}

export function dispatcherConfirmTitle(
  plan: Extract<DispatcherBulkPlan, { block: null }>,
  scope: 'group' | 'selected',
): string {
  const where = scope === 'group' ? ' в группе' : '';
  return plan.mode === 'check'
    ? `Отметить «Диспетчер»${where}: ${deliveriesCount(plan.count)} без отметки?`
    : `Снять отметку «Диспетчер»${where}: ${deliveriesCount(plan.count)}?`;
}

/** Тексты итога: что изменилось и что пропущено (уже в нужном состоянии — не пропуск). */
export function dispatcherBulkResult(
  res: DispatcherBulkCheckResponse,
  checked: boolean,
): { success: string | null; warning: string | null } {
  const n = res.changed.length;
  const success =
    n > 0
      ? checked
        ? `Отмечено диспетчером: ${deliveriesCount(n)}`
        : `Отметка диспетчера снята: ${deliveriesCount(n)}`
      : null;
  const labels: Record<string, string> = {
    not_found: 'не найдены',
    pending_deletion: 'помечены на удаление',
    not_reviewable: 'ещё не оформлены',
  };
  const counts = new Map<string, number>();
  for (const s of res.skipped) {
    if (s.reason === 'already') continue;
    counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  }
  const skipped = [...counts.entries()].map(([reason, k]) => `${k} — ${labels[reason] ?? reason}`);
  const warning = skipped.length
    ? `Пропущено: ${skipped.join('; ')}`
    : n === 0
      ? checked
        ? 'Все уже отмечены диспетчером'
        : 'Отметки диспетчера уже сняты'
      : null;
  return { success, warning };
}
