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

/**
 * Шаг «по имени», когда строки с ИНН справочника в операционной таблице нет.
 *
 * У ООО "МАСТЕР" в «Контрагентах» три разных ИНН — это тёзки, а не одна
 * организация. Прежде маршрут брал первую одноимённую строку (LIMIT 1) и мог
 * вернуть тёзку с чужим ИНН. Теперь при корректном ИНН справочника годится
 * только строка с ИНН-заглушкой, и отбор идёт ДО выбора: тёзка с бо́льшим
 * числом приёмок не должен заслонить заглушку.
 */
suite('from-directory: тёзки с чужим ИНН (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const run = String(Date.now()).slice(-6);
  const siteId = randomUUID();
  const name = `ООО "МАСТЕР ${run}"`;
  const lonely = `ООО "ТЁЗКА ${run}"`;
  const loose = `ООО "НЕВЕРНЫЙ ИНН ${run}"`;
  const plain = `ООО "БЕЗ ИНН ${run}"`;
  const innMaster = validInn(`94${run}1`);
  const innNamesake = validInn(`94${run}2`);
  const innLonely = validInn(`94${run}3`);
  const innOther = validInn(`94${run}4`);
  // Те же девять цифр, но контрольная сдвинута: длина верная, сумма — нет.
  const innBad = (() => {
    const ok = validInn(`94${run}5`);
    return ok.slice(0, 9) + String((Number(ok[9]) + 1) % 10);
  })();
  const placeholderInn = `0000${run}ab`;
  const ccMaster = randomUUID();
  const ccLonely = randomUUID();
  const ccLoose = randomUUID();
  const ccPlain = randomUUID();
  const namesake = randomUUID();
  const placeholder = randomUUID();
  const lonelyNamesake = randomUUID();
  const looseNamesake = randomUUID();
  const plainRow = randomUUID();
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`FN${run.slice(-4)}`}, 'from-directory тёзки')`;
    await sql`INSERT INTO customer_counterparties (id, inn, name) VALUES
      (${ccMaster}, ${innMaster}, ${name}),
      (${ccLonely}, ${innLonely}, ${lonely}),
      (${ccLoose}, ${innBad}, ${loose}),
      (${ccPlain}, '', ${plain})`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name, created_at) VALUES
      (${namesake}, ${innNamesake}, NULL, ${name}, now() - interval '3 days'),
      (${placeholder}, ${placeholderInn}, NULL, ${name}, now()),
      (${lonelyNamesake}, ${innOther}, NULL, ${lonely}, now()),
      (${looseNamesake}, ${innOther.slice(0, 9) + innOther[9]}, '770101001', ${loose}, now()),
      (${plainRow}, ${validInn(`94${run}6`)}, NULL, ${plain}, now())`;
    // У тёзки больше приёмок: прежний выбор по сортировке отдал бы его.
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id)
        VALUES (${randomUUID()}, ${siteId},
                (SELECT id FROM statuses WHERE entity_type='delivery' AND code='not_filled'),
                ${namesake})`;
    }
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE name IN (${name}, ${lonely}, ${loose}, ${plain})`;
    await sql`DELETE FROM customer_counterparties WHERE id IN (${ccMaster}, ${ccLonely}, ${ccLoose}, ${ccPlain})`;
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
    return res.json() as { id: string; name: string; inn: string };
  }

  it('заглушка, а не тёзка с бо́льшим числом приёмок; заглушка получает ИНН справочника', async () => {
    const cp = await pick(ccMaster);
    expect(cp.id).toBe(placeholder);
    expect(cp.inn).toBe(innMaster);
    const rows = await sql<{ id: string }[]>`SELECT id FROM counterparties WHERE name = ${name}`;
    expect(rows).toHaveLength(2);
  });

  it('только тёзка с чужим корректным ИНН — новая строка с ИНН справочника', async () => {
    const cp = await pick(ccLonely);
    expect(cp.id).not.toBe(lonelyNamesake);
    expect(cp.inn).toBe(innLonely);
    // Повтор находит уже её — по ИНН, первым шагом.
    expect((await pick(ccLonely)).id).toBe(cp.id);
  });

  it('ИНН справочника с неверной контрольной суммой — поиск по имени как раньше', async () => {
    expect((await pick(ccLoose)).id).toBe(looseNamesake);
  });

  it('без ИНН в справочнике — одноимённая строка как раньше', async () => {
    expect((await pick(ccPlain)).id).toBe(plainRow);
  });
});
