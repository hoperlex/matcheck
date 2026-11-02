/**
 * Ожидание прохода автовыгрузки УПД — шлюз между частями выгрузки договоров.
 *
 * Проход считается состоявшимся, если в `edo_export_runs` есть завершённый
 * (`completed`) проход этой учётки, начатый после `after`. Опрос раз в
 * `pollMs`, не дольше `maxWaitMs`.
 *
 * Дата уходит в запрос строкой с явным `::timestamptz`. Боевой клиент `sql`
 * обёрнут в `drizzle()` (src/db/client.ts), а драйвер drizzle для postgres.js
 * подменяет в этом же клиенте сериализаторы дат на «прозрачные». После этого
 * объект `Date` в «сыром» `sql` не сериализуется, и запрос падает («The
 * "string" argument must be of type string… Received an instance of Date»).
 * Так выгрузка упала при первом запуске на бою.
 */
import type { Sql } from 'postgres';

export type AutoExportWaitDeps = {
  sql: Sql;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
};

export async function autoExportPassedSince(sql: Sql, accountId: string, after: Date): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from edo_export_runs
     where edo_account_id = ${accountId}
       and outcome = 'completed'
       and started_at > ${after.toISOString()}::timestamptz`;
  return (row?.n ?? 0) > 0;
}

export async function waitAutoExportPass(
  deps: AutoExportWaitDeps,
  accountId: string,
  after: Date,
  maxWaitMs: number,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 30_000;
  const until = now() + maxWaitMs;
  for (;;) {
    if (await autoExportPassedSince(deps.sql, accountId, after)) return true;
    if (now() >= until) return false;
    await sleep(pollMs);
  }
}
