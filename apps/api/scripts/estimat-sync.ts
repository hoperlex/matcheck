/**
 * Ручная работа с заказами поставщикам EstiMat — тот же обход, что делает
 * mail-worker (src/domain/estimat/supplier-orders-sync.ts), но по команде и
 * независимо от ESTIMAT_SYNC_ENABLED. Им проверяют токен и делают первую загрузку
 * перед включением выключателя.
 *
 *   --check             спецификация отвечает и версия ≥ 1.6.0; /capabilities —
 *                       права токена и до какого объекта он сужен; одна страница заказов
 *   --dry-run           обход без записи: сколько заказов, по стадиям, какие коды
 *                       объектов не совпали с sites.code
 *   (без флагов)        обычный обход с записью (trigger='script')
 *   --accept-deletions  снять предохранитель массового исчезновения на этот обход
 *
 * Токен берётся только из env (ESTIMAT_API_TOKEN) и никуда не печатается.
 *
 * Коды выхода: 0 — успех; 1 — ошибка; 2 — обход уже идёт или строку обхода
 * закрыл другой процесс.
 *
 * Запуск на бою:
 *   docker compose -f infra/docker-compose.prod.yml exec -T matcheck-mail-worker \
 *     npx tsx scripts/estimat-sync.ts --check
 */
import { parseArgs } from 'node:util';
import { db, sql } from '../src/db/client.js';
import { sites } from '../src/db/schema.js';
import { readEstimatConfig } from '../src/domain/estimat/config.js';
import { createEstimatClient } from '../src/domain/estimat/estimat.http.js';
import { estimatDryRun, runEstimatSync } from '../src/domain/estimat/supplier-orders-sync.js';
import { errorChain } from '../src/lib/error-chain.js';
import { loadEnv } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'accept-deletions': { type: 'boolean', default: false },
  },
});

const MIN_CONTRACT = [1, 6, 0];

function versionAtLeast(version: string, min: number[]): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    const v = parts[i] ?? 0;
    if (Number.isNaN(v)) return false;
    if (v !== min[i]) return v > min[i]!;
  }
  return true;
}

function top(record: Record<string, number>, limit = 30): string {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '—';
  const shown = entries.slice(0, limit).map(([k, n]) => `${k || '(пусто)'}: ${n}`);
  return shown.join(', ') + (entries.length > limit ? ` … ещё ${entries.length - limit}` : '');
}

async function main(): Promise<number> {
  const env = loadEnv();
  const config = readEstimatConfig(env);
  if (!config.ok) {
    console.error(`EstiMat не настроен: ${config.reason}`);
    return 1;
  }
  console.info(`token: set, len=${config.token.length}`);
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
  const client = createEstimatClient({
    baseUrl: config.baseUrl,
    token: config.token,
    signal: controller.signal,
    onWait: (ms, reason) => console.info(`  пауза ${Math.round(ms / 1000)} с (${reason})`),
  });

  if (args.check) {
    const version = await client.openapiVersion();
    console.info(`Спецификация: версия ${version ?? 'не указана'}`);
    if (!version || !versionAtLeast(version, MIN_CONTRACT)) {
      console.error(`Нужна версия контракта не ниже ${MIN_CONTRACT.join('.')}`);
      return 1;
    }
    const caps = await client.capabilities();
    console.info(
      [
        `Права токена: ${caps.scopes.join(', ') || '—'}`,
        `Доступ: ${caps.projectId ? `только объект ${caps.projectId} (удалённые будут помечаться только в его пределах)` : 'все объекты'}`,
        `Срок токена: ${caps.expiresAt ?? 'бессрочный'}`,
      ].join('\n'),
    );
    if (!caps.scopes.includes('purchases:read')) {
      console.error('Токену не выдано право purchases:read');
      return 1;
    }
    const page = await client.listSupplierOrders(null);
    console.info(`Заказы: первая страница ${page.data.length} строк, ${page.meta.nextCursor ? 'есть ещё' : 'страниц больше нет'}`);
    return 0;
  }

  if (args['dry-run']) {
    const siteRows = await db.select({ id: sites.id, code: sites.code }).from(sites);
    const r = await estimatDryRun(client, siteRows);
    console.info(
      [
        `Заказов: ${r.orders} (страниц ${r.pages}), с визой: ${r.approved}, не разобрано строк: ${r.invalidRows}`,
        `По стадиям: ${top(r.byStage)}`,
        `Без кода объекта: ${r.noCode}`,
        `Код объекта не найден в портале: ${top(r.unmatchedCodes)}`,
        `Код объекта неоднозначен: ${top(r.ambiguousCodes)}`,
        `Сопоставлено без точек и пробелов: ${top(r.compactMatches)}`,
      ].join('\n'),
    );
    return 0;
  }

  const result = await runEstimatSync(
    { db, log: logger.child({ service: 'estimat-sync-script' }), config, signal: controller.signal },
    { trigger: 'script', acceptDeletions: args['accept-deletions'] },
  );
  if ('skipped' in result) {
    console.info(`Обход пропущен: ${result.skipped}${'reason' in result ? ` — ${result.reason}` : ''}`);
    return result.skipped === 'already_running' || result.skipped === 'run_lost' ? 2 : 1;
  }
  const c = result.counters;
  console.info(
    [
      `Обход ${result.runId}: ${result.outcome} за ${Math.round(result.durationMs / 1000)} с`,
      `  заказов ${c.ordersSeen} (страниц ${c.pages}, рестартов ${c.restarts}): новых ${c.inserted}, обновлено ${c.updated}`,
      `  виза менялась у ${c.approvalChanges}, стадия — у ${c.statusChanges}; помечено удалёнными ${c.markedDeleted}, возвращено ${c.restored}`,
      `  не разобрано строк ${c.invalidRows + c.invalidRowsNoId}, объект не сопоставлен у ${c.unmatchedSites}`,
      result.deletionSkippedReason ? `  удалённые не помечались: ${result.deletionSkippedReason}` : null,
      result.errorMessage ? `  ошибка ${result.errorCode}: ${result.errorMessage}${result.requestId ? ` (requestId ${result.requestId})` : ''}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return result.outcome === 'completed' ? 0 : result.outcome === 'stopped' ? 2 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(errorChain(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
