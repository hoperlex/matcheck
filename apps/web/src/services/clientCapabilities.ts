/**
 * Что умеет портал — заголовок X-Matcheck-Capabilities на каждом запросе.
 *
 * group_claim_v1 — портал понимает typed-отказы протокола «одна машина — одна
 * приёмка» (group_claimed и др.) и показывает их сообщением. На объектах, где
 * протокол включён, сервер отвечает 426 клиенту без этого признака: старая
 * сборка такие ответы не понимает (см. apps/api/src/domain/groups/claim-scope.ts).
 */
export const CAPABILITIES_HEADER = 'X-Matcheck-Capabilities';
export const PORTAL_CAPABILITIES = 'group_claim_v1';
