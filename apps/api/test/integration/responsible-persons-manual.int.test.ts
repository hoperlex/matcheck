/**
 * Ручные МОЛ (кладовщики, которых нет в ФОТ) на живой БД.
 *
 * Что доказываем:
 *  - POST никогда не меняет существующих записей: тёзка активен → existing,
 *    ручной тёзка в архиве → 409 без правки (вернуть — PATCH, своё право);
 *  - архивная ФОТ-запись создание ручной не блокирует (Бегас: выпал из ФОТ,
 *    принимать продолжает);
 *  - одновременные POST одного ФИО дают одну запись;
 *  - PATCH не делает второго активного МОЛ с тем же ФИО;
 *  - архив МОЛ не рвёт ссылку документа на него;
 *  - миграция 0150 и её откат: журнал, перепроверка ссылок, решения после
 *    миграции откат не отменяет.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import { responsiblePersonRoutes } from '../../src/routes/responsiblePersons.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

type RpRow = {
  id: string;
  full_name: string;
  position: string | null;
  phone: string | null;
  is_active: boolean;
  fot_employee_id: string | null;
  updated_at: string | Date;
};

suite('ручные МОЛ (PostgreSQL)', { timeout: 60_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  // Метка прогона в каждом ФИО: таблица общая с другими наборами, а дедуп
  // работает по ФИО — чужие строки не должны совпасть с нашими.
  const tag = randomUUID().slice(0, 8);
  const name = (s: string) => `${s} ${tag}`;
  const managerId = randomUUID();
  const siteId = randomUUID();
  const deliveryIds: string[] = [];
  // ФОТ-идентификаторы из диапазона, которого нет в реальном ФОТ.
  const fotBase = 900_000_000 + Math.floor(Math.random() * 1_000_000);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 8 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
    const user: AuthUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    };
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = user;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (n: number) => { send: (v: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) reply.code(403).send({ error: 'forbidden' });
        },
    );
    await app.register(responsiblePersonRoutes);
    await app.ready();
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`RP${siteId.slice(0, 6)}`}, 'Ручные МОЛ')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    if (deliveryIds.length) await sql`DELETE FROM deliveries WHERE id IN ${sql(deliveryIds)}`;
    await sql`DELETE FROM responsible_persons WHERE full_name LIKE ${`%${tag}%`}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/responsible-persons', payload: body });
  const patch = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/responsible-persons/${id}`, payload: body });
  const byId = async (id: string) =>
    (await sql<RpRow[]>`SELECT * FROM responsible_persons WHERE id = ${id}`)[0]!;
  const byName = (fullName: string) =>
    sql<RpRow[]>`SELECT * FROM responsible_persons WHERE lower(btrim(full_name)) = lower(btrim(${fullName}))`;

  async function insertRow(opts: { fullName: string; active: boolean; fot?: number; position?: string }) {
    const id = randomUUID();
    await sql`INSERT INTO responsible_persons (id, full_name, position, phone, is_active, fot_employee_id, updated_at)
      VALUES (${id}, ${opts.fullName}, ${opts.position ?? null}, ${opts.position ? '+70000000000' : null},
        ${opts.active}, ${opts.fot ?? null}, now() - interval '1 day')`;
    return id;
  }

  it('новое ФИО → 201 created, запись активна, видна в списке выбора', async () => {
    const res = await post({ fullName: `  ${name('Пиронов Ф.Б.')}  `, position: 'Кладовщик', isActive: false });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.outcome).toBe('created');
    // Крайние пробелы срезает контракт; isActive из тела POST не берётся.
    expect(body.fullName).toBe(name('Пиронов Ф.Б.'));
    expect(body.isActive).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/responsible-persons?activeOnly=true&limit=500&q=${encodeURIComponent(tag)}`,
    });
    expect(list.json().items.map((r: { id: string }) => r.id)).toContain(body.id);
  });

  it('активный тёзка (ручной, другой регистр) → 200 existing, запись не тронута', async () => {
    const id = await insertRow({ fullName: name('Доброход Н.О.'), active: true, position: 'Кладовщик' });
    const before = await byId(id);
    const res = await post({ fullName: name('ДОБРОХОД н.о.'), position: 'Другая', phone: '1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, outcome: 'existing' });
    expect(await byId(id)).toEqual(before);
    expect(await byName(name('Доброход Н.О.'))).toHaveLength(1);
  });

  it('активный тёзка из ФОТ → 200 existing с ФОТ-записью, ручной не заводится', async () => {
    const fotId = await insertRow({ fullName: name('Начальник Участка'), active: true, fot: fotBase + 1 });
    const res = await post({ fullName: name('Начальник Участка') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: fotId, outcome: 'existing' });
    expect(await byName(name('Начальник Участка'))).toHaveLength(1);
  });

  it('архивная ФОТ-запись не блокирует: создаётся ручная, ФОТ остаётся в архиве', async () => {
    const fotId = await insertRow({ fullName: name('Бегас Дмитрий Федорович'), active: false, fot: fotBase + 2 });
    const res = await post({ fullName: name('Бегас Дмитрий Федорович'), position: 'Кладовщик' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.outcome).toBe('created');
    expect(body.id).not.toBe(fotId);
    expect((await byId(fotId)).is_active).toBe(false);
  });

  it('ручной тёзка в архиве → 409 mol_archived, запись не изменена (POST — не правка)', async () => {
    const id = await insertRow({ fullName: name('Лосев Б.С.'), active: false, position: 'ПТО' });
    const before = await byId(id);
    const res = await post({ fullName: name('Лосев Б.С.'), position: 'Кладовщик', phone: '+7999' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'mol_archived', existing: { id, isActive: false } });
    // is_active, должность, телефон и updated_at — как были.
    expect(await byId(id)).toEqual(before);
    expect(await byName(name('Лосев Б.С.'))).toHaveLength(1);
  });

  it('ФИО из одних пробелов → 400', async () => {
    expect((await post({ fullName: '    ' })).statusCode).toBe(400);
  });

  it('POST ждёт блокировку ФИО и перепроверяет после неё — дубля нет', async () => {
    // Детерминированная гонка: «другой POST» держит блокировку этого ФИО и
    // вставляет запись, пока наш ждёт. Без блокировки наш POST ответил бы
    // сразу и завёл вторую запись (Promise.all ниже это окно почти не ловит).
    const fullName = name('Муминов Параллельный');
    const key = `responsible_person:${fullName.trim().toLowerCase()}`;
    const otherId = randomUUID();
    let locked!: () => void;
    let release!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const gate = new Promise<void>((r) => (release = r));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      locked();
      await gate;
      await tx`INSERT INTO responsible_persons (id, full_name) VALUES (${otherId}, ${fullName})`;
    });
    await lockedP;

    const pending = post({ fullName });
    const first = await Promise.race([
      pending.then(() => 'answered' as const),
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 300)),
    ]);
    expect(first).toBe('waiting');

    release();
    await holder;
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: otherId, outcome: 'existing' });
    expect(await byName(fullName)).toHaveLength(1);
  });

  it('одновременные POST одного ФИО → одна запись: один created, остальные existing', async () => {
    const fullName = name('Студзинский');
    const results = await Promise.all(Array.from({ length: 5 }, () => post({ fullName })));
    const outcomes = results.map((r) => r.json().outcome).sort();
    expect(outcomes).toEqual(['created', 'existing', 'existing', 'existing', 'existing']);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await byName(fullName)).toHaveLength(1);
  });

  it('PATCH: возврат из архива при активном тёзке → 409 mol_name_taken; без тёзки → 200', async () => {
    const activeId = await insertRow({ fullName: name('Муминов'), active: true });
    const archivedId = await insertRow({ fullName: name('Муминов'), active: false });
    const clash = await patch(archivedId, { isActive: true });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: 'mol_name_taken', existing: { id: activeId } });
    expect((await byId(archivedId)).is_active).toBe(false);

    // Тёзку увели в архив — теперь вернуть можно, updated_at растёт (дельта /sync).
    expect((await patch(activeId, { isActive: false })).statusCode).toBe(200);
    const before = await byId(archivedId);
    const ok = await patch(archivedId, { isActive: true });
    expect(ok.statusCode).toBe(200);
    const after = await byId(archivedId);
    expect(after.is_active).toBe(true);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
  });

  it('PATCH: переименование в ФИО активного МОЛ → 409; ФОТ-запись → 409 fot_readonly', async () => {
    await insertRow({ fullName: name('Занятое ФИО'), active: true });
    const id = await insertRow({ fullName: name('Свободное ФИО'), active: true });
    const res = await patch(id, { fullName: name('занятое фио') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('mol_name_taken');
    expect((await byId(id)).full_name).toBe(name('Свободное ФИО'));

    const fotId = await insertRow({ fullName: name('ФОТ Только Чтение'), active: true, fot: fotBase + 3 });
    const fot = await patch(fotId, { position: 'x' });
    expect(fot.statusCode).toBe(409);
    expect(fot.json().error).toBe('fot_readonly');
  });

  it('архив ручного МОЛ не рвёт ссылку приёмки и убирает его из списка выбора', async () => {
    const created = (await post({ fullName: name('Кладовщик Со Ссылкой') })).json();
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const deliveryId = randomUUID();
    deliveryIds.push(deliveryId);
    await sql`INSERT INTO deliveries (id, site_id, status_id, recipient_mol_id, purpose)
      VALUES (${deliveryId}, ${siteId}, ${status!.id}, ${created.id}, 'own_forces')`;

    expect((await patch(created.id, { isActive: false })).statusCode).toBe(200);
    const [delivery] = await sql<{ recipient_mol_id: string | null }[]>`
      SELECT recipient_mol_id FROM deliveries WHERE id = ${deliveryId}`;
    expect(delivery!.recipient_mol_id).toBe(created.id);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/responsible-persons?activeOnly=true&limit=500&q=${encodeURIComponent(tag)}`,
    });
    expect(list.json().items.map((r: { id: string }) => r.id)).not.toContain(created.id);
  });
});

/**
 * Миграция 0150 на живой БД: прогон down → up → «правка менеджера» → down → up.
 * Фикстуры берут id из списка миграции — другие строки она не трогает.
 */
suite('миграция 0150: архив старых ручных МОЛ и точный откат', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  const up = readFileSync(join(migrationsDir, '0150_archive_legacy_manual_mol.sql'), 'utf8');
  const down = readFileSync(join(migrationsDir, '0150_down.sql'), 'utf8');
  // Из списка миграции: Ахмадуллов, Белорусец, Берсенев, Бешлей.
  const plain = 'cb538a93-81dd-44ce-b46d-7805b759d63e'; // активный, без ссылок
  const archivedBefore = '9470bc87-ee93-4e87-b509-46939cb69904'; // в архиве до миграции
  const referenced = '317ffdbe-d52e-4fe4-9e16-e33447419a1e'; // на него ссылается приёмка
  const touched = '33c95719-acc6-43c1-8369-cedb476bc266'; // менеджер правит после миграции
  const ids = [plain, archivedBefore, referenced, touched];
  const outsider = randomUUID(); // ручной МОЛ не из списка
  const siteId = randomUUID();
  const deliveryId = randomUUID();

  async function run(text: string) {
    const statements = text
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const s of statements) await tx.unsafe(s);
    });
  }
  const active = async (id: string) =>
    (await sql<{ is_active: boolean }[]>`SELECT is_active FROM responsible_persons WHERE id = ${id}`)[0]!
      .is_active;
  const journal = async () =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM responsible_persons_archived_0150 WHERE id IN ${sql([...ids, outsider])} ORDER BY id`
    ).map((r) => r.id);
  const journalExists = async () =>
    (await sql<{ t: string | null }[]>`SELECT to_regclass('public.responsible_persons_archived_0150')::text AS t`)[0]!
      .t !== null;

  async function cleanup() {
    await sql`DELETE FROM deliveries WHERE id = ${deliveryId}`;
    await sql`DELETE FROM responsible_persons WHERE id IN ${sql([...ids, outsider])}`;
    if (await journalExists()) {
      await sql`DELETE FROM responsible_persons_archived_0150 WHERE id IN ${sql([...ids, outsider])}`;
    }
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 2, onnotice: () => {} });
    await cleanup();
  });

  afterAll(async () => {
    if (!sql) return;
    // Схема должна остаться как после миграции, даже если тест упал посередине.
    if (!(await journalExists())) await run(up);
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it('архивирует только активных без ссылок из списка; откат не отменяет чужих решений', async () => {
    // Исходное состояние «до миграции».
    await run(down);
    expect(await journalExists()).toBe(false);
    for (const id of ids) {
      await sql`INSERT INTO responsible_persons (id, full_name, is_active, updated_at)
        VALUES (${id}, ${`Импорт 01.06 ${id.slice(0, 8)}`}, ${id !== archivedBefore}, '2026-06-01T15:11:43Z')`;
    }
    await sql`INSERT INTO responsible_persons (id, full_name, is_active, updated_at)
      VALUES (${outsider}, ${`Не из списка ${outsider.slice(0, 8)}`}, true, '2026-06-01T15:11:43Z')`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`M0${siteId.slice(0, 6)}`}, 'Миграция 0150')`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    await sql`INSERT INTO deliveries (id, site_id, status_id, recipient_mol_id, purpose)
      VALUES (${deliveryId}, ${siteId}, ${status!.id}, ${referenced}, 'own_forces')`;

    await run(up);
    expect(await active(plain)).toBe(false);
    expect(await active(touched)).toBe(false);
    expect(await active(archivedBefore)).toBe(false);
    expect(await active(referenced)).toBe(true); // ссылка перепроверена при применении
    expect(await active(outsider)).toBe(true); // не из списка — не трогаем
    expect(await journal()).toEqual([plain, touched].sort());

    // Менеджер после миграции вернул запись и снова отправил в архив.
    await sql`UPDATE responsible_persons SET is_active = true, updated_at = clock_timestamp() WHERE id = ${touched}`;
    await sql`UPDATE responsible_persons SET is_active = false, updated_at = clock_timestamp() WHERE id = ${touched}`;

    await run(down);
    expect(await active(plain)).toBe(true); // нетронутая — вернулась
    expect(await active(touched)).toBe(false); // решение менеджера сохранено
    expect(await active(archivedBefore)).toBe(false); // была в архиве до миграции
    expect(await active(referenced)).toBe(true);
    expect(await journalExists()).toBe(false);

    // Повторный down без журнала безопасен; up возвращает схему.
    await run(down);
    await run(up);
    expect(await journalExists()).toBe(true);
    expect(await active(plain)).toBe(false);
  });
});
