/**
 * Ожидание прохода автовыгрузки УПД — на настоящем PostgreSQL и клиентом как в
 * бою: `postgres(…, { prepare: false })`, обёрнутый в `drizzle()`. Обёртка
 * важна: драйвер drizzle подменяет у клиента сериализаторы дат, и объект `Date`
 * в «сыром» `sql` после этого падает. Первый боевой запуск выгрузки договоров
 * упал именно здесь, а тест с голым клиентом этого не видел.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoExportPassedSince, waitAutoExportPass } from '../../src/domain/edo/contracts/auto-export-wait.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('ожидание прохода автовыгрузки УПД (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  const accounts: string[] = [];

  async function account(): Promise<string> {
    const id = randomUUID();
    accounts.push(id);
    await sql`insert into edo_accounts (id, name, credentials_encrypted, box_id)
              values (${id}, ${`ЭДО ${id.slice(0, 8)}`}, '{}', ${`box-${id.slice(0, 8)}`})`;
    return id;
  }

  async function pass(accountId: string, startedAt: Date, outcome = 'completed') {
    await sql`insert into edo_export_runs (edo_account_id, scope, trigger, outcome, started_at, finished_at)
              values (${accountId}, 'all', 'auto', ${outcome},
                      ${startedAt.toISOString()}::timestamptz, ${startedAt.toISOString()}::timestamptz)`;
  }

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2, prepare: false });
    // Как в src/db/client.ts: drizzle() меняет сериализаторы дат у этого же клиента.
    drizzle(sql);
  });

  afterAll(async () => {
    if (accounts.length > 0) {
      await sql`delete from edo_export_runs where edo_account_id in ${sql(accounts)}`;
      await sql`delete from edo_accounts where id in ${sql(accounts)}`;
    }
    await sql.end({ timeout: 5 });
  });

  it('завершённый проход после отметки — дождались', async () => {
    const id = await account();
    const after = new Date(Date.now() - 60_000);
    await pass(id, new Date(after.getTime() + 1_000));
    expect(await autoExportPassedSince(sql, id, after)).toBe(true);
    expect(await waitAutoExportPass({ sql, sleep: async () => {} }, id, after, 60_000)).toBe(true);
  });

  it('проход до отметки, незавершённый или чужой учётки — не считается', async () => {
    const id = await account();
    const other = await account();
    const after = new Date(Date.now() - 60_000);
    await pass(id, new Date(after.getTime() - 1_000));
    await pass(id, new Date(after.getTime() + 1_000), 'running');
    await pass(id, new Date(after.getTime() + 2_000), 'error');
    await pass(other, new Date(after.getTime() + 3_000));
    expect(await autoExportPassedSince(sql, id, after)).toBe(false);
  });

  it('проходов нет — ожидание кончается «не дождались», опрашивая базу', async () => {
    const id = await account();
    let clock = 0;
    const slept: number[] = [];
    const result = await waitAutoExportPass(
      {
        sql,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
        pollMs: 30_000,
      },
      id,
      new Date(),
      90_000,
    );
    expect(result).toBe(false);
    expect(slept).toEqual([30_000, 30_000, 30_000]);
  });
});
