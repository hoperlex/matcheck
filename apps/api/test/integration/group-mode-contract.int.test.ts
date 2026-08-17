/**
 * Стык клиент↔сервер группового режима.
 *
 * Зачем этот набор существует. Групповой режим полгода был выкачен наполовину:
 * сервер умел отдавать групповой контракт, мобильный клиент умел его рисовать,
 * а строку `capabilities=source_groups_v1`, которой клиент о себе заявляет, не
 * слал никто. Обе половины были зелёными по отдельности — просто потому, что
 * ни один тест не проверял их ВМЕСТЕ: слова `source_groups_v1` не было ни в
 * одном серверном тесте.
 *
 * Отсюда предмет проверки: не «работает ли предикат видимости» (это проверяет
 * mobile-visibility.int.test.ts), а «включается ли режим ровно тогда, когда
 * должен». Три условия — флаг, объект, capability — и каждое обязано уметь
 * сказать «нет».
 *
 * Почему через process.env + resetModules. loadEnv() кэширует разбор окружения
 * в модульной переменной, сбросить её иначе нечем; тот же приём применяют
 * наборы про PERMISSIONS_ENFORCE.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
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

/** MUST MATCH SERVER: SOURCE_GROUPS_CAPABILITY в domain/groups/group-mode.ts. */
const CAPABILITY = 'source_groups_v1';

suite('групповой режим: стык capability ↔ сервер (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;

  // Два объекта: один в canary-списке, второй намеренно вне его. Иначе
  // «протекает ли режим на чужой объект» проверить нечем.
  const canarySiteId = randomUUID();
  const otherSiteId = randomUUID();
  const inspectorId = randomUUID();
  const otherInspectorId = randomUUID();
  const managerId = randomUUID();
  // Получатель обязателен: без contractor_id (или recipient_mol_id) документ
  // не проходит HAS_REQUIRED_FIELDS и считается черновиком, каким бы parsed он
  // ни был. ИНН уникален, а базу делят все наборы — отсюда суффикс времени.
  const contractorId = randomUUID();
  const contractorInn = `77${String(Date.now()).slice(-8)}`;

  /** Готовый документ: проходит предикат видимости целиком. */
  const readyDocId = randomUUID();
  /** Неготовый: needs_resolution — на планшет в групповом режиме не уезжает. */
  const notReadyDocId = randomUUID();
  /** Готовый документ ЧУЖОГО объекта, вне canary. */
  const otherSiteDocId = randomUUID();
  /** Неготовый документ чужого объекта — им и ловится протечка режима. */
  const otherSiteNotReadyId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${canarySiteId}, ${`GMC${Date.now() % 100000}`}, 'Групповой canary')`;
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${otherSiteId}, ${`GMO${Date.now() % 100000}`}, 'Вне canary')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`gm-${inspectorId}@test`}, 'x', 'inspector_kpp', ${canarySiteId})`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${otherInspectorId}, ${`gm-${otherInspectorId}@test`}, 'x', 'inspector_kpp', ${otherSiteId})`;
    // Менеджер без объекта — именно у него siteId = null, и именно на нём
    // проверяется, не включается ли режим сразу на всё.
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`gm-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name)
              VALUES (${contractorId}, ${contractorInn}, NULL, 'ООО «Групповой подрядчик»')`;

    // Готовый документ: parsed, реквизиты заполнены, получатель определён.
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date, contractor_id, updated_at)
      VALUES (${readyDocId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${canarySiteId}, now(),
              'GM-READY', now(), 100, now(), ${contractorId}, now() - interval '1 hour')`;
    // Неготовый отличается ТОЛЬКО статусом: иначе тест доказывал бы не то, что
    // режим скрывает необработанное, а что фикстура неполна.
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date, contractor_id, updated_at)
      VALUES (${notReadyDocId}, 'upd', false, 'inbound', 'manual_pdf', 'needs_resolution', ${canarySiteId}, now(),
              'GM-NOTREADY', now(), 200, now(), ${contractorId}, now() - interval '1 hour')`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date, contractor_id, updated_at)
      VALUES (${otherSiteDocId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${otherSiteId}, now(),
              'GM-OTHER', now(), 300, now(), ${contractorId}, now() - interval '1 hour')`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date, contractor_id, updated_at)
      VALUES (${otherSiteNotReadyId}, 'upd', false, 'inbound', 'manual_pdf', 'needs_resolution', ${otherSiteId}, now(),
              'GM-OTHER-NR', now(), 400, now(), ${contractorId}, now() - interval '1 hour')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id IN (${canarySiteId}, ${otherSiteId})`;
    await sql`DELETE FROM users WHERE id IN (${inspectorId}, ${otherInspectorId}, ${managerId})`;
    await sql`DELETE FROM sites WHERE id IN (${canarySiteId}, ${otherSiteId})`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql.end({ timeout: 5 });
  });

  /**
   * Поднимает /sync с заданным окружением и пользователем.
   *
   * Роуты импортируются динамически ПОСЛЕ подмены process.env: иначе loadEnv()
   * закэширует прежние значения, и переключение флага ничего не изменит.
   */
  async function buildApp(opts: {
    groupModeV1: '0' | '1';
    groupModeSites: string;
    user: AuthUser;
  }): Promise<FastifyInstance> {
    process.env.GROUP_MODE_V1 = opts.groupModeV1;
    process.env.GROUP_MODE_SITES = opts.groupModeSites;
    vi.resetModules();
    const { syncRoutes } = await import('../../src/routes/sync.js');

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = opts.user;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(syncRoutes);
    await app.ready();
    return app;
  }

  function userOf(id: string, role: AuthUser['role'], siteId: string | null): AuthUser {
    return {
      id,
      role,
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    } as unknown as AuthUser;
  }

  async function delta(
    app: FastifyInstance,
    query: string,
  ): Promise<{ ids: string[]; body: Record<string, unknown> }> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/sync?windowDays=90${query}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sourceDocuments: { id: string }[] } & Record<string, unknown>;
    return { ids: body.sourceDocuments.map((d) => d.id), body };
  }

  it('без capability режим не включается — неготовый документ приезжает, как раньше', async () => {
    // Ровно то состояние, в котором клиент прожил всё время: флаг на сервере
    // поднят, объект в списке, а планшет о себе не заявил.
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      const { ids } = await delta(app, '');
      expect(ids).toContain(readyDocId);
      expect(ids).toContain(notReadyDocId);
    } finally {
      await app.close();
    }
  });

  it('с capability на canary-объекте неготовый документ скрыт', async () => {
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      const { ids } = await delta(app, `&capabilities=${CAPABILITY}`);
      expect(ids).toContain(readyDocId);
      expect(ids).not.toContain(notReadyDocId);
    } finally {
      await app.close();
    }
  });

  it('capability есть, но объект вне списка — прежний контракт', async () => {
    // Canary обязан быть пообъектным: инспектор соседнего объекта не должен
    // замечать переключения вообще.
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(otherInspectorId, 'inspector_kpp', otherSiteId),
    });
    try {
      const { ids } = await delta(app, `&capabilities=${CAPABILITY}`);
      expect(ids).toContain(otherSiteDocId);
      expect(ids).toContain(otherSiteNotReadyId);
    } finally {
      await app.close();
    }
  });

  it('флаг выключен — capability ничего не меняет', async () => {
    const app = await buildApp({
      groupModeV1: '0',
      groupModeSites: canarySiteId,
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      const { ids } = await delta(app, `&capabilities=${CAPABILITY}`);
      expect(ids).toContain(notReadyDocId);
    } finally {
      await app.close();
    }
  });

  it('пустой список объектов — режим не включается ни для кого', async () => {
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: '',
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      const { ids } = await delta(app, `&capabilities=${CAPABILITY}`);
      expect(ids).toContain(notReadyDocId);
    } finally {
      await app.close();
    }
  });

  it('менеджер без объекта не включает режим на объектах вне canary', async () => {
    // У менеджера site_id = null, поэтому проверка объекта в resolveGroupMode
    // пропускается, и предикат видимости применяется ко ВСЕЙ его выдаче —
    // включая объекты, которые в canary не входят. Для инспектора соседнего
    // объекта режим выключен, а тот же документ у менеджера исчезает: охват
    // зависит от роли смотрящего, а не от объекта.
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(managerId, 'manager', null),
    });
    try {
      const { ids } = await delta(app, `&capabilities=${CAPABILITY}`);
      // Свой объект в canary — скрытие законно.
      expect(ids).not.toContain(notReadyDocId);
      // Чужой объект вне canary — трогать его нельзя.
      expect(ids).toContain(otherSiteNotReadyId);
    } finally {
      await app.close();
    }
  });

  it('nextPageToken на последней странице — null, а не отсутствие поля', async () => {
    // Контракт зафиксирован именно так: клиент читает поле как nullable и
    // отличает «страница последняя» от «сервер старый» только по нему.
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      const { body } = await delta(app, `&capabilities=${CAPABILITY}`);
      expect(body).toHaveProperty('nextPageToken');
      expect(body.nextPageToken).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reconcile отбирает документы тем же предикатом, что дельта', async () => {
    // Разъедься эти два места — дельта прислала бы tombstone на скрытый
    // документ, а сверка через минуту вернула бы его обратно.
    const app = await buildApp({
      groupModeV1: '1',
      groupModeSites: canarySiteId,
      user: userOf(inspectorId, 'inspector_kpp', canarySiteId),
    });
    try {
      // Планшет не знает ни об одном документе — сервер должен назвать то, что
      // надо докачать. Скрытого среди этого быть не может, иначе клиент вернул
      // бы его через detail-роут сразу после tombstone из дельты.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/reconcile',
        payload: {
          deliveries: [],
          shipments: [],
          sourceDocuments: [],
          capabilities: CAPABILITY,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        sourceDocuments: { missingOnClient: { id: string }[] };
      };
      const missing = body.sourceDocuments.missingOnClient.map((d) => d.id);
      expect(missing).toContain(readyDocId);
      expect(missing).not.toContain(notReadyDocId);
    } finally {
      await app.close();
    }
  });
});
