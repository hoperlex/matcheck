/**
 * POST /counterparties/from-directory: какая операционная строка достаётся
 * получателю, когда под ИНН подрядчика их несколько.
 *
 * Приёмка 21713: под ИНН СТРОЙПАРТНЕРа лежали «ООО "СтройПартнер"» без КПП,
 * его подразделение и «ООО "СТРОЙСЕРВИС"» — мусор распознавания. Маршрут брал
 * строку через LIMIT 1 без порядка и мог поставить в чип чужое имя. При одной
 * строке на ИНН результат обязан остаться прежним.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';
import { counterpartyRoutes } from '../../src/routes/counterparties.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Корректный десятизначный ИНН из девяти цифр: дописывает контрольную. */
function validInn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}

suite('from-directory: выбор операционной строки (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const run = String(Date.now()).slice(-6);
  const siteId = randomUUID();
  const multiInn = validInn(`93${run}1`);
  const singleInn = validInn(`93${run}2`);
  const ccMulti = randomUUID();
  const ccSingle = randomUUID();
  const junk = randomUUID();
  const branch = randomUUID();
  const main = randomUUID();
  const single = randomUUID();
  const user = { id: randomUUID(), role: 'manager', siteId: null } as unknown as AuthUser;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = user;
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(counterpartyRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`FD${run.slice(-4)}`}, 'from-directory')`;
    await sql`INSERT INTO customer_counterparties (id, inn, name) VALUES
      (${ccMulti}, ${multiInn}, ${`ООО "СТРОЙПАРТНЕР ${run}"`}),
      (${ccSingle}, ${singleInn}, ${`ООО "ФОРУМ ${run}"`})`;
    // Мусор — самый старый и самый «используемый»: прежний LIMIT 1 без
    // порядка на свежей таблице обычно отдавал именно его.
    await sql`INSERT INTO counterparties (id, inn, kpp, name, created_at) VALUES
      (${junk}, ${multiInn}, '772501001', ${`ООО "СТРОЙСЕРВИС ${run}"`}, now() - interval '3 days'),
      (${branch}, ${multiInn}, '772201001', ${`ООО "СтройПартнер ${run}"`}, now() - interval '2 days'),
      (${main}, ${multiInn}, NULL, ${`ООО "СтройПартнер ${run}"`}, now() - interval '1 day'),
      (${single}, ${singleInn}, '770101001', ${`ООО "Чужое имя ${run}"`}, now())`;
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id)
              VALUES (${randomUUID()}, ${siteId},
                      (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'),
                      ${junk})`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE inn IN (${multiInn}, ${singleInn})`;
    await sql`DELETE FROM customer_counterparties WHERE id IN (${ccMulti}, ${ccSingle})`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function pick(customerCounterpartyId: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/counterparties/from-directory',
      payload: { customerCounterpartyId, context: 'delivery' },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; name: string; inn: string; isContractor: boolean };
  }

  it('21713: строка с именем как в «Контрагентах» и без КПП, а не мусор', async () => {
    const cp = await pick(ccMulti);
    expect(cp.id).toBe(main);
    expect(cp.isContractor).toBe(true);
    // Повтор даёт ту же строку.
    expect((await pick(ccMulti)).id).toBe(main);
    // Флаг подрядчика поднят только у выбранной строки.
    const flags = await sql<{ id: string; is_contractor: boolean }[]>`
      SELECT id, is_contractor FROM counterparties WHERE inn = ${multiInn} ORDER BY id`;
    expect(Object.fromEntries(flags.map((f) => [f.id, f.is_contractor]))).toEqual({
      [junk]: false,
      [branch]: false,
      [main]: true,
    });
  });

  it('одна строка на ИНН — она, даже с чужим именем и КПП (как раньше)', async () => {
    const cp = await pick(ccSingle);
    expect(cp.id).toBe(single);
    expect(cp.name).toBe(`ООО "Чужое имя ${run}"`);
  });
});
