/**
 * Быстрый холостой путь `/sync`.
 *
 * Обработчик выполняет около сорока обращений к БД независимо от того,
 * изменилось ли что-нибудь, а планшеты опрашивают его постоянно: SSE
 * рассылается всем подключённым без скоупа. Замер 25.08 на бою: 712 запросов за
 * полчаса, медиана 3321 мс — больше целого ядра на одну ручку.
 *
 * Предмет проверки здесь не «быстро ли», а «не теряется ли дельта». Асимметрия
 * ошибок принципиальная: лишнее срабатывание полного пути безвредно, пропуск
 * изменения — потеря записи навсегда, потому что клиент сдвинет курсор.
 *
 * Почему `since` в будущем. База делится между наборами, и глобальные
 * справочники (контрагенты, материалы, единицы) может изменить кто угодно.
 * Граница в будущем делает проверку детерминированной: «новее» неё нет ничего,
 * кроме того, что набор создал сам.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts. Без TEST_DATABASE_URL
 * набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('/sync: быстрый холостой путь (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;

  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const inspectorId = randomUUID();

  /** Граница дельты — в будущем, чтобы «новее» было только своё. */
  const since = new Date(Date.now() + 60 * 60 * 1000);
  /** Момент «после границы» для строк, которые обязаны разбудить полный путь. */
  const afterSince = new Date(since.getTime() + 60 * 1000).toISOString();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`FE${Date.now() % 100000}`}, 'Быстрый путь')`;
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${otherSiteId}, ${`FO${Date.now() % 100000}`}, 'Чужой объект')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`fe-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;
    // Объекты созданы «сейчас», то есть до границы: сами по себе они быстрый
    // путь не ломают.
    await sql`UPDATE sites SET updated_at = now() WHERE id IN (${siteId}, ${otherSiteId})`;

    const { syncRoutes } = await import('../../src/routes/sync.js');
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = {
        id: inspectorId,
        role: 'inspector_kpp',
        siteId,
        contractorCustomerId: null,
        sessionId: randomUUID(),
      } as unknown as AuthUser;
    });
    app.decorate(
      'authorize',
      () => async () => {},
    );
    await app.register(syncRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (!sql) return;
    await app?.close();
    await sql`DELETE FROM source_document_visibility_events WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM entity_deletions WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM deliveries WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM source_documents WHERE site_id IN (${siteId}, ${otherSiteId})`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id IN (${siteId}, ${otherSiteId})`;
    await sql.end({ timeout: 5 });
  });

  async function delta(query = ''): Promise<Record<string, unknown>> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sync?since=${encodeURIComponent(since.toISOString())}${query}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  it('без изменений отдаёт пустую дельту и nextPageToken = null', async () => {
    const body = await delta();
    expect(body.deliveries).toEqual([]);
    expect(body.shipments).toEqual([]);
    expect(body.sourceDocuments).toEqual([]);
    expect(body.nextPageToken).toBeNull();
  });

  it('справочники статусов и единиц приходят и на быстром пути', async () => {
    // Свойство, на которое клиент вправе рассчитывать: они отдаются в КАЖДОМ
    // ответе без дельта-фильтра, и планшет, потерявший справочник,
    // восстанавливает его следующей же синхронизацией.
    const body = await delta();
    expect((body.statuses as unknown[]).length).toBeGreaterThan(0);
    expect((body.units as unknown[]).length).toBeGreaterThan(0);
  });

  it('изменение на ЧУЖОМ объекте инспектора не будит', async () => {
    // Скоуп обязан совпадать со скоупом самой выдачи: чужую приёмку обработчик
    // всё равно не отдаст, будить ради неё планшет незачем.
    const foreignId = randomUUID();
    const statusId = (
      await sql`SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`
    )[0].id as string;
    await sql`INSERT INTO deliveries (id, status_id, site_id, updated_at)
              VALUES (${foreignId}, ${statusId}, ${otherSiteId}, ${afterSince}::timestamptz)`;
    try {
      const body = await delta();
      expect(body.deliveries).toEqual([]);
    } finally {
      await sql`DELETE FROM deliveries WHERE id = ${foreignId}`;
    }
  });

  it('приёмка своего объекта уводит на полный путь', async () => {
    const id = randomUUID();
    const statusId = (
      await sql`SELECT id FROM statuses WHERE entity_type='delivery' AND code='filled' LIMIT 1`
    )[0].id as string;
    await sql`INSERT INTO deliveries (id, status_id, site_id, updated_at)
              VALUES (${id}, ${statusId}, ${siteId}, ${afterSince}::timestamptz)`;
    try {
      const body = await delta();
      expect((body.deliveries as { id: string }[]).map((d) => d.id)).toContain(id);
    } finally {
      await sql`DELETE FROM deliveries WHERE id = ${id}`;
    }
  });

  it('hard-delete уводит на полный путь — по updated_at его не найти', async () => {
    // entity_deletions живёт своей колонкой deleted_at, и поиск только по
    // updated_at основных таблиц пропустил бы удаление навсегда.
    const gone = randomUUID();
    await sql`INSERT INTO entity_deletions (id, entity_type, entity_id, site_id, deleted_at)
              VALUES (${randomUUID()}, 'delivery', ${gone}, ${siteId}, ${afterSince}::timestamptz)`;
    try {
      const body = await delta();
      expect((body.deletedIds as { deliveries: string[] }).deliveries).toContain(gone);
    } finally {
      await sql`DELETE FROM entity_deletions WHERE entity_id = ${gone}`;
    }
  });

  it('visibility-tombstone уводит на полный путь', async () => {
    // Скрытие документа не меняет ни одной строки source_documents: событие
    // пишется в отдельный журнал. Без его проверки планшет никогда не узнал бы,
    // что карточку пора убрать.
    const docId = randomUUID();
    // Причина именно «объект документа изменён»: при выключенном рубильнике
    // сервер отдаёт из журнала только переносы объекта (см. sync.ts) — прочие
    // события существуют, но в дельту не попадают. Проверяем, что быстрый путь
    // видит запись в журнале, а не то, какие причины сервер решает показывать.
    await sql`INSERT INTO source_document_visibility_events
                (source_document_id, visibility, site_id, reason, created_at)
              VALUES (${docId}, 'hidden', ${siteId}, 'объект документа изменён', ${afterSince}::timestamptz)`;
    try {
      const body = await delta();
      expect((body.deletedIds as { sourceDocuments: string[] }).sourceDocuments).toContain(docId);
    } finally {
      await sql`DELETE FROM source_document_visibility_events WHERE source_document_id = ${docId}`;
    }
  });

  // Глобальные справочники по ответу не различить: и быстрый, и полный путь
  // отдают единицы одинаково. Поэтому проверяем сам предикат напрямую — иначе
  // тест был бы зелёным при любой поломке.
  it('изменение единиц измерения предикат видит', async () => {
    // Единицы редактируются через API, значит их updated_at обязан входить в
    // проверку. Статусы — нет: таблица неизменяема и колонки updated_at у неё
    // не существует.
    const { hasDeltaChanges } = await import('../../src/domain/sync/delta-changes.js');
    const db = drizzle(sql) as never;
    expect(await hasDeltaChanges(db, { since, siteId })).toBe(false);

    const unit = (await sql`SELECT id, updated_at FROM units LIMIT 1`)[0] as {
      id: string;
      updated_at: Date;
    };
    await sql`UPDATE units SET updated_at = ${afterSince}::timestamptz WHERE id = ${unit.id}`;
    try {
      expect(await hasDeltaChanges(db, { since, siteId })).toBe(true);
    } finally {
      await sql`UPDATE units SET updated_at = ${unit.updated_at} WHERE id = ${unit.id}`;
    }
  });

  it('изменение контрагента предикат видит — справочник глобальный', async () => {
    // У справочников нет site_id, и фильтровать их по объекту нельзя: клиент
    // получает их целиком независимо от своего объекта.
    const { hasDeltaChanges } = await import('../../src/domain/sync/delta-changes.js');
    const db = drizzle(sql) as never;
    const cp = (await sql`SELECT id, updated_at FROM counterparties LIMIT 1`)[0] as {
      id: string;
      updated_at: Date;
    };
    await sql`UPDATE counterparties SET updated_at = ${afterSince}::timestamptz WHERE id = ${cp.id}`;
    try {
      expect(await hasDeltaChanges(db, { since, siteId })).toBe(true);
    } finally {
      await sql`UPDATE counterparties SET updated_at = ${cp.updated_at} WHERE id = ${cp.id}`;
    }
  });

  it('initial-sync быстрым путём не идёт', async () => {
    // since == null: отдавать всегда есть что, и пропуск здесь означал бы
    // планшет с пустой базой навсегда.
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect((body.statuses as unknown[]).length).toBeGreaterThan(0);
  });

  it('страница продолжения быстрым путём не идёт', async () => {
    // Курсор клиент двигает только после ПОСЛЕДНЕЙ страницы: «пустой» ответ в
    // середине обхода оборвал бы его на полпути и потерял хвост.
    //
    // Отличить пути можно только в групповом режиме: именно там токен
    // разбирается и курсор становится равен снимку из него. Без режима токен
    // игнорируется, и оба пути отдают неразличимый пустой ответ.
    process.env.GROUP_MODE_V1 = '1';
    process.env.GROUP_MODE_SITES = siteId;
    vi.resetModules();
    const { syncRoutes } = await import('../../src/routes/sync.js');
    const grouped = Fastify({ logger: false });
    grouped.setValidatorCompiler(validatorCompiler);
    grouped.setSerializerCompiler(serializerCompiler);
    grouped.decorate('db', drizzle(sql) as never);
    grouped.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = {
        id: inspectorId,
        role: 'inspector_kpp',
        siteId,
        contractorCustomerId: null,
        sessionId: randomUUID(),
      } as unknown as AuthUser;
    });
    grouped.decorate('authorize', () => async () => {});
    await grouped.register(syncRoutes);
    await grouped.ready();

    try {
      const token = Buffer.from(
        JSON.stringify({
          snapshot: since.toISOString(),
          updatedAt: since.toISOString(),
          id: randomUUID(),
        }),
        'utf8',
      ).toString('base64url');
      const res = await grouped.inject({
        method: 'GET',
        url:
          `/api/v1/sync?since=${encodeURIComponent(since.toISOString())}` +
          `&capabilities=source_groups_v1&pageToken=${token}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      // Курсор равен снимку токена — значит запрос прошёл полным путём.
      // Быстрый вернул бы `now − буфер`, то есть заметно раньше.
      expect(body.cursor).toBe(since.toISOString());
    } finally {
      await grouped.close();
      delete process.env.GROUP_MODE_V1;
      delete process.env.GROUP_MODE_SITES;
    }
  });
});
