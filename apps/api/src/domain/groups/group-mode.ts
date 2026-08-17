/**
 * Групповой режим: когда машина из нескольких документов становится одной
 * поставкой, а на планшет уезжает только обработанное.
 *
 * Режим включается ТРЕМЯ условиями сразу, и все три обязательны:
 *
 *   1. `GROUP_MODE_V1=1` — глобальный рубильник;
 *   2. объект в `GROUP_MODE_SITES` (или список = `*`) — canary по объектам;
 *   3. клиент прислал capability `source_groups_v1` — он умеет typed-конфликты
 *      и восстанавливаемые черновики.
 *
 * Третье условие — не формальность и не оптимизация. Старая сборка не понимает
 * `source_documents_not_ready` и `group_changed`: неизвестный 409 у неё
 * превращается в Drop, то есть в заблокированную сущность без внятного
 * объяснения инспектору. Поэтому клиент БЕЗ capability всегда получает прежний
 * контракт, даже если объект уже переведён в новый режим. Плата за это —
 * временно сохраняющийся риск частичной приёмки на старых устройствах; он
 * закрывается подъёмом minSupportedVersionCode, когда парк обновится.
 *
 * Следствие для выкатки: site-флаг НИКОГДА не меняет поведение старого клиента.
 * Планшет, вернувшийся из недельного офлайна, продолжает работать по-старому и
 * не получает протокол, которого не знает.
 */
import { loadEnv } from '../../lib/env.js';

/** Capability, которой клиент заявляет поддержку группового протокола. */
export const SOURCE_GROUPS_CAPABILITY = 'source_groups_v1';

/** Значение `GROUP_MODE_SITES`, включающее режим на всех объектах. */
const ALL_SITES = '*';

/**
 * Разбирает query-параметр `capabilities` (список через запятую).
 *
 * Пустая строка и отсутствие параметра дают пустой набор — то есть старый
 * клиент, для которого ничего не меняется.
 */
export function parseCapabilities(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Заявил ли клиент поддержку группового протокола. */
export function clientSupportsGroups(capabilities: Set<string>): boolean {
  return capabilities.has(SOURCE_GROUPS_CAPABILITY);
}

/**
 * Включён ли режим для конкретного объекта — без учёта клиента.
 *
 * Нужен там, где решение принимается по документу, а не по запросу: у
 * менеджера в `/sync` объекта нет вовсе, и документы приезжают с разных.
 */
export function groupModeEnabledForSite(siteId: string | null | undefined): boolean {
  const env = loadEnv();
  if (!env.GROUP_MODE_V1) return false;
  const sites = env.GROUP_MODE_SITES;
  if (sites.length === 0) return false;
  if (sites.includes(ALL_SITES)) return true;
  if (!siteId) return false;
  return sites.includes(siteId);
}

/** Объекты, на которых режим включён. `null` — все (список = `*`). */
export function groupModeSites(): string[] | null {
  const env = loadEnv();
  if (!env.GROUP_MODE_V1) return [];
  const sites = env.GROUP_MODE_SITES;
  if (sites.includes(ALL_SITES)) return null;
  return sites;
}

/**
 * Решение по запросу целиком: применять ли групповой протокол этому клиенту.
 *
 * `siteId` — объект инспектора КПП; для admin/manager он не задан, и тогда
 * охват определяется пообъектно уже на уровне выборки.
 */
export function resolveGroupMode(args: {
  siteId: string | null | undefined;
  capabilities: Set<string>;
}): { enabled: boolean; reason: 'off' | 'no_capability' | 'site_excluded' | 'on' } {
  const env = loadEnv();
  if (!env.GROUP_MODE_V1 || env.GROUP_MODE_SITES.length === 0) {
    return { enabled: false, reason: 'off' };
  }
  if (!clientSupportsGroups(args.capabilities)) {
    return { enabled: false, reason: 'no_capability' };
  }
  // Инспектор привязан к объекту — проверяем его сразу. Менеджеру объект не
  // задан: охват решается пообъектно при выборке документов.
  if (args.siteId && !groupModeEnabledForSite(args.siteId)) {
    return { enabled: false, reason: 'site_excluded' };
  }
  return { enabled: true, reason: 'on' };
}
