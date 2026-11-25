// Связи «подрядчик × объект → вид» в карточке контрагента (routes/customer-counterparties.ts).
//
// Чтение: действующий вид = manual_kind, если задан, иначе onec_kind; строки
// 'none' (скрыты вручную) не отдаются. Наблюдатель видит только свои объекты,
// суммы 1С — только admin и manager (allow-list правки карточки).
//
// Правка: карточка присылает полный список «объект → вид» и версию, по которой
// открыта. Вызывающий маршрут ДО этого делает UPDATE строки
// customer_counterparties в той же транзакции: строковая блокировка ставит
// две карточки одного контрагента в очередь, а ROW EXCLUSIVE на таблице не
// совместим с SHARE импорта — карточка и импорт идут строго по очереди.
// Поэтому связи читаются обычным SELECT (READ COMMITTED — свежий снимок).

import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  ContractorSiteKind,
  CustomerCounterpartySite,
  CustomerCounterpartySiteInput,
} from '@matcheck/contracts';
import {
  customerCounterpartySites,
  sites,
  SYSTEM_SITE_ID,
  type ContractorSiteManualKind,
} from '../../db/schema.js';
import type { Executor } from './apply.js';

export type ContractorSitesCardErrorCode =
  | 'contractor_sites_conflict'
  | 'duplicate_site'
  | 'unknown_site'
  | 'system_site';

export class ContractorSitesCardError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: ContractorSitesCardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContractorSitesCardError';
  }
}

export type SitesViewer = {
  role: string;
  /** Объекты наблюдателя (siteScopeOf) или null — без ограничения. */
  siteScope: readonly string[] | null;
};

type VersionRow = {
  siteId: string;
  onecKind: string | null;
  manualKind: ContractorSiteManualKind | null;
};

/** Версия связей контрагента — по ВСЕМ строкам, включая скрытые. */
export function sitesVersionOf(rows: readonly VersionRow[]): string {
  const parts = rows.map((r) => `${r.siteId}:${r.onecKind ?? '-'}:${r.manualKind ?? '-'}`).sort();
  return createHash('md5').update(parts.join(',')).digest('hex');
}

function effectiveKind(r: VersionRow): ContractorSiteKind | null {
  if (r.manualKind === 'none') return null;
  return (r.manualKind ?? r.onecKind) as ContractorSiteKind | null;
}

const SUM_ROLES = new Set(['admin', 'manager']);

export type LoadedSites = { sites: CustomerCounterpartySite[]; sitesVersion: string };

/**
 * Связи для списка или одной карточки. 'all' — вся таблица (на бою ~150 строк):
 * дешевле, чем IN на 5000 id страницы справочника.
 */
export async function loadContractorSites(
  ex: Executor,
  ccIds: readonly string[] | 'all',
  viewer: SitesViewer,
): Promise<Map<string, LoadedSites>> {
  const out = new Map<string, LoadedSites>();
  if (ccIds !== 'all' && ccIds.length === 0) return out;
  const base = ex
    .select({
      ccId: customerCounterpartySites.customerCounterpartyId,
      siteId: customerCounterpartySites.siteId,
      onecKind: customerCounterpartySites.onecKind,
      onecRealizationDocs: customerCounterpartySites.onecRealizationDocs,
      onecRealizationSum: customerCounterpartySites.onecRealizationSum,
      onecTollingDocs: customerCounterpartySites.onecTollingDocs,
      onecTollingSum: customerCounterpartySites.onecTollingSum,
      onecObjects: customerCounterpartySites.onecObjects,
      onecLoadedAt: customerCounterpartySites.onecLoadedAt,
      manualKind: customerCounterpartySites.manualKind,
      siteCode: sites.code,
      siteName: sites.name,
      siteActive: sites.isActive,
    })
    .from(customerCounterpartySites)
    .innerJoin(sites, eq(sites.id, customerCounterpartySites.siteId));
  const rows =
    ccIds === 'all'
      ? await base
      : await base.where(inArray(customerCounterpartySites.customerCounterpartyId, [...ccIds]));

  const byCc = new Map<string, typeof rows>();
  for (const r of rows) byCc.set(r.ccId, [...(byCc.get(r.ccId) ?? []), r]);
  const scope = viewer.siteScope ? new Set(viewer.siteScope) : null;
  const showSums = SUM_ROLES.has(viewer.role);

  const ids = ccIds === 'all' ? [...byCc.keys()] : ccIds;
  for (const id of ids) {
    const own = byCc.get(id) ?? [];
    const visible: CustomerCounterpartySite[] = [];
    for (const r of own) {
      const kind = effectiveKind(r);
      if (!kind) continue;
      if (scope && !scope.has(r.siteId)) continue;
      visible.push({
        siteId: r.siteId,
        siteCode: r.siteCode,
        siteName: r.siteName,
        siteActive: r.siteActive,
        kind,
        manual: r.manualKind !== null,
        onec:
          r.onecKind === null || r.onecLoadedAt === null
            ? null
            : {
                kind: r.onecKind,
                realizationDocs: r.onecRealizationDocs ?? 0,
                tollingDocs: r.onecTollingDocs ?? 0,
                realizationSum: showSums ? (r.onecRealizationSum ?? '0.00') : null,
                tollingSum: showSums ? (r.onecTollingSum ?? '0.00') : null,
                objects: r.onecObjects ?? [],
                loadedAt: r.onecLoadedAt.toISOString(),
              },
      });
    }
    visible.sort(
      (a, b) =>
        Number(b.siteActive) - Number(a.siteActive) || a.siteCode.localeCompare(b.siteCode, 'ru'),
    );
    out.set(id, { sites: visible, sitesVersion: sitesVersionOf(own) });
  }
  return out;
}

/** Версия контрагента без связей (ccIds='all' не вернёт его в Map). */
export const EMPTY_SITES: LoadedSites = { sites: [], sitesVersion: sitesVersionOf([]) };

type PgErrorLike = { code?: unknown; constraint_name?: unknown };

/** Нарушение FK на объект (customer_counterparty_sites_site_id_fkey). */
function isSiteFkViolation(err: unknown): boolean {
  const e = err as (PgErrorLike & { cause?: PgErrorLike }) | null;
  const pg = typeof e?.code === 'string' ? e : e?.cause;
  return (
    pg?.code === '23503' &&
    typeof pg.constraint_name === 'string' &&
    pg.constraint_name.includes('site_id')
  );
}

/**
 * Применить список из карточки. Строку, которую не меняли, не трогаем (вид 1С
 * остаётся видом 1С); изменённая или новая — ручная; пропавшая строка 1С
 * скрывается ('none'), чтобы повторная загрузка её не вернула; пропавшая
 * ручная без 1С удаляется.
 */
export async function applyCardSites(
  tx: Executor,
  args: {
    ccId: string;
    items: readonly CustomerCounterpartySiteInput[];
    /** null — проверка версии не нужна (новый контрагент). */
    version: string | null | undefined;
    requireVersion: boolean;
    userId: string | null;
  },
): Promise<void> {
  const current = await tx
    .select({
      siteId: customerCounterpartySites.siteId,
      onecKind: customerCounterpartySites.onecKind,
      manualKind: customerCounterpartySites.manualKind,
    })
    .from(customerCounterpartySites)
    .where(eq(customerCounterpartySites.customerCounterpartyId, args.ccId));
  if (args.requireVersion && args.version !== sitesVersionOf(current)) {
    throw new ContractorSitesCardError(
      409,
      'contractor_sites_conflict',
      'Объекты у подрядчика успели изменить — откройте карточку заново',
    );
  }

  const wanted = new Map<string, ContractorSiteKind>();
  for (const item of args.items) {
    if (wanted.has(item.siteId))
      throw new ContractorSitesCardError(422, 'duplicate_site', 'Объект указан дважды');
    if (item.siteId === SYSTEM_SITE_ID)
      throw new ContractorSitesCardError(422, 'system_site', 'Служебный объект выбрать нельзя');
    wanted.set(item.siteId, item.kind);
  }
  if (wanted.size > 0) {
    const found = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(inArray(sites.id, [...wanted.keys()]));
    if (found.length !== wanted.size)
      throw new ContractorSitesCardError(422, 'unknown_site', 'Объект не найден');
  }

  const now = new Date();
  const byId = new Map(current.map((r) => [r.siteId, r]));
  const where = (siteId: string) =>
    and(
      eq(customerCounterpartySites.customerCounterpartyId, args.ccId),
      eq(customerCounterpartySites.siteId, siteId),
    );
  try {
    for (const [siteId, kind] of wanted) {
      const cur = byId.get(siteId);
      if (cur && effectiveKind(cur) === kind) continue;
      if (cur) {
        await tx
          .update(customerCounterpartySites)
          .set({ manualKind: kind, manualByUserId: args.userId, manualAt: now, updatedAt: now })
          .where(where(siteId));
      } else {
        await tx.insert(customerCounterpartySites).values({
          customerCounterpartyId: args.ccId,
          siteId,
          manualKind: kind,
          manualByUserId: args.userId,
          manualAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    for (const cur of current) {
      if (wanted.has(cur.siteId) || effectiveKind(cur) === null) continue;
      if (cur.onecKind !== null) {
        await tx
          .update(customerCounterpartySites)
          .set({ manualKind: 'none', manualByUserId: args.userId, manualAt: now, updatedAt: now })
          .where(where(cur.siteId));
      } else {
        await tx.delete(customerCounterpartySites).where(where(cur.siteId));
      }
    }
  } catch (err) {
    // Объект удалили между проверкой и вставкой.
    if (isSiteFkViolation(err))
      throw new ContractorSitesCardError(422, 'unknown_site', 'Объект не найден');
    throw err;
  }
}
