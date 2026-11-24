/**
 * Ручной шаг после выката 0156: scripts/counterparty-zero-inn-2026-11-24.sql.
 *
 * Строки counterparties с ИНН «0» (до выпуска так заводился поставщик без ИНН)
 * получают ИНН-заглушку «0000…», updated_at = now() и, если имя однозначно,
 * ссылку на запись «Поставщиков». updated_at проверяется через /sync: планшет
 * получает контрагентов дельтой по updated_at, и без сдвига замену не увидел бы.
 *
 * Скрипт меняет ВСЕ строки «0» в базе, поэтому набор работает в своей базе на
 * сервере TEST_DATABASE_URL (как directories-import.int.test.ts) и в конце её
 * удаляет. Без TEST_DATABASE_URL набор пропускается.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const SCRIPT = readFileSync(
  new URL('../../scripts/counterparty-zero-inn-2026-11-24.sql', import.meta.url),
  'utf8',
);
const EST = 'ООО "СТРОИТЕЛЬНАЯ КОМПАНИЯ "ЭСТ"';

suite('ручной шаг: ИНН «0» → заглушка (реальный PostgreSQL)', { timeout: 180_000 }, () => {
  const dbName = `matcheck_zero_inn_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  /** Одно соединение: файл скрипта сам открывает и закрывает транзакцию, как в psql. */
  let script: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  const managerId = randomUUID();

  beforeAll(async () => {
    admin = postgres(TEST_DATABASE_URL!, { max: 1 });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    execFileSync('node_modules/.bin/tsx', ['scripts/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'ignore',
    });
    sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
    script = postgres(url.toString(), { max: 1, onnotice: () => {} });

    const { syncRoutes } = await import('../../src/routes/sync.js');
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;
    });
    app.decorate('authorize', () => async () => {});
    await app.register(syncRoutes);
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
    await script?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end({ timeout: 5 });
  });

  async function row(id: string) {
    const [r] = await sql<
      { inn: string; supplier_directory_id: string | null; updated_at: Date }[]
    >`select inn, supplier_directory_id, updated_at from counterparties where id = ${id}`;
    return r!;
  }

  it('«ЭСТ»: заглушка, ссылка на единственную одноимённую запись, дельта /sync её отдаёт', async () => {
    const dir = randomUUID();
    await sql`insert into suppliers (id, inn, name) values
                (${dir}, '', ${EST}),
                (${randomUUID()}, '', ${`${EST} Основной склад`}),
                (${randomUUID()}, '7707083893', ${EST})`;
    const [created] = await sql<{ id: string }[]>`
      insert into counterparties (inn, kpp, name, is_supplier, updated_at)
      values ('0', null, ${EST}, true, '2026-10-21T05:23:38Z') returning id`;
    const id = created!.id;

    const before = new Date(Date.now() - 1000);
    await script.unsafe(SCRIPT);

    const after = await row(id);
    expect(after.inn).toMatch(/^0000[0-9a-f]{8}$/);
    expect(after.supplier_directory_id).toBe(dir);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(before.getTime());

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?since=${encodeURIComponent(before.toISOString())}`,
    });
    expect(res.statusCode).toBe(200);
    const cps = (res.json() as { counterparties: { id: string; inn: string }[] }).counterparties;
    expect(cps.find((c) => c.id === id)?.inn).toBe(after.inn);

    // Повтор ничего не меняет: строк «0» нет, updated_at прежний.
    await script.unsafe(SCRIPT);
    expect(await row(id)).toEqual(after);
  });

  it('две одноимённые записи справочника без ИНН — заглушка без ссылки', async () => {
    const name = 'ООО "ДВОЙНИК"';
    await sql`insert into suppliers (id, inn, name) values
                (${randomUUID()}, '', ${name}),
                (${randomUUID()}, ' ', ${name})`;
    const [created] = await sql<{ id: string }[]>`
      insert into counterparties (inn, kpp, name, is_supplier)
      values ('0', null, ${name}, true) returning id`;
    const id = created!.id;

    await script.unsafe(SCRIPT);

    const after = await row(id);
    expect(after.inn).toMatch(/^0000[0-9a-f]{8}$/);
    expect(after.supplier_directory_id).toBeNull();
    const [zeros] = await sql<{ n: number }[]>`
      select count(*)::int as n from counterparties where inn = '0'`;
    expect(zeros!.n).toBe(0);
  });
});
