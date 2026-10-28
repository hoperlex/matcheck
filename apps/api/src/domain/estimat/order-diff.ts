import type { EstimatOrderEventKind } from '../../db/schema.js';
import { SYSTEM_SITE_ID } from '../../db/schema.js';

/**
 * Чистые правила обхода: какие события журнала даёт смена состояния заказа и
 * к какому объекту портала он относится. Отдельно от записи в БД — чтобы
 * правила проверялись тестами без базы.
 */

export type OrderPrevState = {
  supplyApprovedAt: Date | null;
  sourcingStatus: string;
  deletedAt: Date | null;
};

export type OrderNextState = {
  supplyApprovedAt: Date | null;
  sourcingStatus: string;
};

export type OrderEventDraft = {
  kind: EstimatOrderEventKind;
  fromValue: string | null;
  toValue: string | null;
  details: Record<string, unknown> | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * События журнала при переходе prev → next.
 *
 * `hadApproval` — у заказа уже есть событие approved/reapproved. Виза снимается,
 * если заказ после неё изменили, и после повторного согласования приходит новая
 * дата — её пишем как «согласован повторно». Заказ, впервые увиденный уже с
 * визой, получает approved сразу при first_seen: иначе цепочка «увидели с визой
 * → сняли → поставили снова» дала бы approved вместо reapproved.
 */
export function diffOrder(
  prev: OrderPrevState | null,
  next: OrderNextState,
  hadApproval: boolean,
): OrderEventDraft[] {
  if (prev === null) {
    const events: OrderEventDraft[] = [
      {
        kind: 'first_seen',
        fromValue: null,
        toValue: next.sourcingStatus,
        details: { stage: next.sourcingStatus, supplyApprovedAt: iso(next.supplyApprovedAt) },
      },
    ];
    if (next.supplyApprovedAt) {
      events.push({ kind: 'approved', fromValue: null, toValue: iso(next.supplyApprovedAt), details: null });
    }
    return events;
  }

  const events: OrderEventDraft[] = [];
  if (prev.deletedAt) events.push({ kind: 'restored', fromValue: iso(prev.deletedAt), toValue: null, details: null });

  const p = prev.supplyApprovedAt?.getTime() ?? null;
  const n = next.supplyApprovedAt?.getTime() ?? null;
  if (p === null && n !== null) {
    events.push({
      kind: hadApproval ? 'reapproved' : 'approved',
      fromValue: null,
      toValue: iso(next.supplyApprovedAt),
      details: null,
    });
  } else if (p !== null && n === null) {
    events.push({ kind: 'approval_revoked', fromValue: iso(prev.supplyApprovedAt), toValue: null, details: null });
  } else if (p !== null && n !== null && p !== n) {
    // Сняли и поставили снова между двумя обходами — промежуточного null мы не видели.
    events.push({
      kind: 'reapproved',
      fromValue: iso(prev.supplyApprovedAt),
      toValue: iso(next.supplyApprovedAt),
      details: null,
    });
  }

  if (prev.sourcingStatus !== next.sourcingStatus) {
    events.push({ kind: 'status_changed', fromValue: prev.sourcingStatus, toValue: next.sourcingStatus, details: null });
  }
  return events;
}

export type SiteRef = { id: string; code: string };

export type SiteMatch =
  | { siteId: string; status: 'matched' }
  | { siteId: null; status: 'no_code' | 'not_found' | 'ambiguous' };

/**
 * Объект портала по коду объекта EstiMat. Точное совпадение `sites.code`
 * единственно (уникальный индекс). Без учёта регистра — только если кандидат
 * ровно один: индекс уникальности регистр различает, и два таких кандидата дали
 * бы выбор наугад. Неоднозначный код — не сопоставлен, а не «первый попавшийся».
 */
export function matchSite(projectCode: string | null, sites: readonly SiteRef[]): SiteMatch {
  const code = projectCode?.trim() ?? '';
  if (!code) return { siteId: null, status: 'no_code' };
  const candidates = sites.filter((s) => s.id !== SYSTEM_SITE_ID);
  const exact = candidates.find((s) => s.code === code);
  if (exact) return { siteId: exact.id, status: 'matched' };
  const upper = code.toUpperCase();
  const loose = candidates.filter((s) => s.code.trim().toUpperCase() === upper);
  if (loose.length === 1) return { siteId: loose[0]!.id, status: 'matched' };
  return { siteId: null, status: loose.length === 0 ? 'not_found' : 'ambiguous' };
}
