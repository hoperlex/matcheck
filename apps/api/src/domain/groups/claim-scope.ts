// Где действуют объединение машин и протокол «одна машина — одна приёмка», и
// что умеет клиент запроса.
//
// Включение — по объектам (GROUP_CLAIM_SITES, MACHINE_MERGE_SITES), а
// возможности клиента — по заголовку X-Matcheck-Capabilities. Заголовок ставит
// сборка, которая ОТПРАВЛЯЕТ запрос и будет разбирать ответ. Поэтому старая
// мутация из очереди, которую повторяет уже обновлённое приложение, приходит с
// заголовком, и сервер вправе ответить ей typed-конфликтом: новая сборка его
// поймёт. Поле тела `capabilities` (строка по контракту) учитывается тоже.

import { loadEnv } from '../../lib/env.js';
import { parseCapabilities } from './group-mode.js';

/** Клиент понимает typed-конфликты занятия машины (group_claimed и др.). */
export const GROUP_CLAIM_CAPABILITY = 'group_claim_v1';

/** Заголовок, которым новые клиенты сообщают свои возможности. */
export const CAPABILITIES_HEADER = 'x-matcheck-capabilities';

function inScope(list: readonly string[], siteId: string | null | undefined): boolean {
  if (list.includes('*')) return true;
  return !!siteId && list.includes(siteId);
}

/** Включено ли объединение машин на объекте. */
export function machineMergeEnabledForSite(siteId: string | null | undefined): boolean {
  return inScope(loadEnv().MACHINE_MERGE_SITES, siteId);
}

/** Действует ли на объекте протокол занятия машины. */
export function groupClaimEnabledForSite(siteId: string | null | undefined): boolean {
  return inScope(loadEnv().GROUP_CLAIM_SITES, siteId);
}

/** Объекты с включённым объединением; `'*'` — все, пустой список — нигде. */
export function machineMergeSites(): string[] {
  return [...loadEnv().MACHINE_MERGE_SITES];
}

/**
 * Возможности клиента: заголовок плюс поле тела. Заголовок может прийти
 * массивом (повтор заголовка) — склеиваем.
 */
export function requestCapabilities(
  headers: Record<string, string | string[] | undefined>,
  bodyField?: string | null,
): Set<string> {
  const raw = headers[CAPABILITIES_HEADER];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  const out = parseCapabilities(header);
  for (const c of parseCapabilities(bodyField ?? undefined)) out.add(c);
  return out;
}

/** Клиент понимает typed-конфликты занятия машины. */
export function clientSupportsGroupClaim(capabilities: Set<string>): boolean {
  return capabilities.has(GROUP_CLAIM_CAPABILITY);
}
