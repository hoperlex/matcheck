/**
 * Интеграционные тесты (реальный PostgreSQL):
 *  - скоуп фото: presign и confirm пускают любого инспектора СВОЕГО объекта
 *    (несколько аккаунтов на объекте — штатный процесс, Этап 1 и Этап 2
 *    закрывают разные смены), режут чужой объект и не пускают read-only роли;
 *  - окно /sync и /sync/reconcile: незавершённые 2 Этапа доезжают, но дельта
 *    не возвращает их бесконечно (иначе клиент листает без остановки).
 *
 * Как запускать — см. шапку foreign-site.int.test.ts.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { photoRoutes } from '../../src/routes/photos.js';
import { syncRoutes } from '../../src/routes/sync.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('скоуп фото и окно sync (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const inspectorA = randomUUID();
  const inspectorA2 = randomUUID(); // тот же объект, другой автор
  const inspectorB = randomUUID();
  let filledStatusId: string;
  let confirmedStatusId: string;
  let shipmentStatusId: string;

  // Приёмки: своя, чужая по объекту, своя по объекту но чужого автора.
  let ownDelivery: string;
  let foreignSiteDelivery: string;
  let sameSiteOtherAuthor: string;
  let ownPhotoId: string;
  let foreignPhotoId: string;

  // Отгрузки — отдельная ветка presign, скоуп у неё свой.
  let foreignSiteShipment: string;
  let sameSiteOtherAuthorShipment: string;

  // Инлайновые 403 в photos.ts пишутся в unauthorized_access_log через этот
  // декоратор. Без него роут падал бы в 500 на недекорированном методе, а с
  // общим моком на весь файл вызовы протекали бы между тестами — отсюда
  // переменная и очистка в beforeEach.
  const logUnauthorized = vi.fn(async () => {});

  beforeEach(() => {
    logUnauthorized.mockClear();
  });

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
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
    app.decorate('logUnauthorized', logUnauthorized as never);
    await app.register(photoRoutes);
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteA}, ${'PSA'}, 'PhotoSync A'), (${siteB}, ${'PSB'}, 'PhotoSync B')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorA}, ${`pa-${inspectorA}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorA2}, ${`pa2-${inspectorA2}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorB}, ${`pb-${inspectorB}@test`}, 'x', 'inspector_kpp', ${siteB})`;

    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [c] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'confirmed_mol' LIMIT 1`;
    const [sh] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    filledStatusId = f!.id;
    confirmedStatusId = c!.id;
    shipmentStatusId = sh!.id;

    ownDelivery = await seedDelivery(siteA, inspectorA, filledStatusId);
    foreignSiteDelivery = await seedDelivery(siteB, inspectorB, filledStatusId);
    sameSiteOtherAuthor = await seedDelivery(siteA, inspectorA2, filledStatusId);
    ownPhotoId = await seedPhoto(ownDelivery);
    foreignPhotoId = await seedPhoto(foreignSiteDelivery);

    foreignSiteShipment = await seedShipment(siteB, inspectorB);
    sameSiteOtherAuthorShipment = await seedShipment(siteA, inspectorA2);
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM shipments WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM users WHERE id = ${inspectorA} OR id = ${inspectorA2} OR id = ${inspectorB}`;
    await sql`DELETE FROM sites WHERE id = ${siteA} OR id = ${siteB}`;
    await sql.end({ timeout: 5 });
  });

  async function seedDelivery(siteId: string, inspectorId: string, statusId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${statusId}, 1)`;
    return id;
  }

  /**
   * kind='writeoff' — единственный вид отгрузки, которому по
   * shipments_kind_links_chk не нужны ни контрагент, ни МОЛ, ни объект
   * назначения. Скоуп фото от вида не зависит, лишние фикстуры ни к чему.
   */
  async function seedShipment(siteId: string, inspectorId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${shipmentStatusId}, 'writeoff', 1)`;
    return id;
  }

  /**
   * uploaded — фото уже подтверждено. Нужно позитивным confirm-тестам: на
   * заполненном uploaded_at роут уходит в идемпотентную ветку и отдаёт 200 без
   * обращения к S3, которого в тестовом окружении нет.
   */
  async function seedPhoto(deliveryId: string, uploaded = false): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO delivery_photos
      (id, delivery_id, kind, s3_key, content_hash, idempotency_key, taken_at, uploaded_at)
      VALUES (${id}, ${deliveryId}, 'cargo', ${`k/${id}.jpg`}, ${id.slice(0, 12)}, ${randomUUID()},
              now(), ${uploaded ? sql`now()` : null})`;
    return id;
  }

  async function seedShipmentPhoto(shipmentId: string, uploaded = false): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipment_photos
      (id, shipment_id, kind, s3_key, content_hash, idempotency_key, taken_at, uploaded_at)
      VALUES (${id}, ${shipmentId}, 'cargo', ${`k/${id}.jpg`}, ${id.slice(0, 12)}, ${randomUUID()},
              now(), ${uploaded ? sql`now()` : null})`;
    return id;
  }

  const asInspector = (id: string, siteId: string): AuthUser => ({
    id,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  const presign = (deliveryId: string, stage?: 'before' | 'after') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: {
        operationKind: 'delivery',
        operationId: deliveryId,
        kind: 'cargo',
        contentType: 'image/jpeg',
        // contentHash по контракту — ровно 64 hex-символа (sha256).
        contentHash: randomUUID().replace(/-/g, '').repeat(2),
        idempotencyKey: randomUUID(),
        ...(stage ? { stage } : {}),
      },
    });

  const presignShipment = (shipmentId: string, stage?: 'before' | 'after') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/photos/presign',
      payload: {
        operationKind: 'shipment',
        operationId: shipmentId,
        kind: 'cargo',
        contentType: 'image/jpeg',
        contentHash: randomUUID().replace(/-/g, '').repeat(2),
        idempotencyKey: randomUUID(),
        ...(stage ? { stage } : {}),
      },
    });

  const confirm = (photoId: string) =>
    app.inject({ method: 'POST', url: `/api/v1/photos/${photoId}/confirm` });

  it('presign: чужой объект → 403 foreign_site + запись в журнал отказов', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(foreignSiteDelivery);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
    expect(logUnauthorized).toHaveBeenCalledWith(
      expect.anything(),
      403,
      'photo_foreign_site',
      inspectorA,
    );
  });

  it('presign: свой объект, чужой автор — фото 2 этапа проходит (передача смены)', async () => {
    // Регрессия приёмки 9539: Этап 1 закрыл один аккаунт объекта, Этап 2 —
    // другой. Owner-check отбивал presign 403-м, статус при этом доезжал, и на
    // портале «2 Этап» оставался пустым.
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(sameSiteOtherAuthor, 'after');

    // S3 в тестовом окружении не настроен: маршрут отдаёт 200 с пустыми URL.
    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const rows = await sql<{ delivery_id: string; stage: string }[]>`
      SELECT delivery_id, stage FROM delivery_photos WHERE id = ${photoId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delivery_id: sameSiteOtherAuthor, stage: 'after' });
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('presign: своя запись своего объекта → 200', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presign(ownDelivery);
    expect(res.statusCode).toBe(200);
  });

  it('presign: contractor и monitor не допускаются', async () => {
    for (const role of ['contractor', 'monitor'] as const) {
      currentUser = {
        id: randomUUID(),
        role,
        siteId: null,
        contractorCustomerId: role === 'contractor' ? randomUUID() : null,
        sessionId: randomUUID(),
      };
      const res = await presign(ownDelivery);
      expect(res.statusCode).toBe(403);
    }
  });

  it('confirm: чужой объект → 403 foreign_site + запись в журнал отказов', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await confirm(foreignPhotoId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
    expect(logUnauthorized).toHaveBeenCalledWith(
      expect.anything(),
      403,
      'photo_foreign_site',
      inspectorA,
    );
  });

  it('confirm: свой объект, чужой автор → 200', async () => {
    // Фото уже подтверждено — роут уходит в идемпотентную ветку и до S3
    // (которого в тестовом окружении нет) не доходит. Проверяем ровно скоуп.
    const photoOfOtherAuthor = await seedPhoto(sameSiteOtherAuthor, true);
    currentUser = asInspector(inspectorA, siteA);
    const res = await confirm(photoOfOtherAuthor);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('presign отгрузки: чужой объект → 403 foreign_site + запись в журнал отказов', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presignShipment(foreignSiteShipment);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
    expect(logUnauthorized).toHaveBeenCalledWith(
      expect.anything(),
      403,
      'photo_foreign_site',
      inspectorA,
    );
  });

  it('presign отгрузки: свой объект, чужой автор → 200', async () => {
    currentUser = asInspector(inspectorA, siteA);
    const res = await presignShipment(sameSiteOtherAuthorShipment, 'after');

    expect(res.statusCode).toBe(200);
    const { photoId } = res.json() as { photoId: string };
    const rows = await sql<{ shipment_id: string; stage: string }[]>`
      SELECT shipment_id, stage FROM shipment_photos WHERE id = ${photoId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shipment_id: sameSiteOtherAuthorShipment,
      stage: 'after',
    });
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('confirm фото отгрузки: свой объект, чужой автор → 200', async () => {
    const photoOfOtherAuthor = await seedShipmentPhoto(sameSiteOtherAuthorShipment, true);
    currentUser = asInspector(inspectorA, siteA);
    const res = await confirm(photoOfOtherAuthor);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(logUnauthorized).not.toHaveBeenCalled();
  });

  it('confirm: contractor не допускается', async () => {
    currentUser = {
      id: randomUUID(),
      role: 'contractor',
      siteId: null,
      contractorCustomerId: randomUUID(),
      sessionId: randomUUID(),
    };
    const res = await confirm(ownPhotoId);
    expect(res.statusCode).toBe(403);
  });

  describe('окно /sync для незавершённых 2 Этапа', () => {
    const OLD_DAYS = 200;

    beforeAll(async () => {
      // 501 старая незавершённая приёмка (filled, updated_at 200 дней назад) —
      // ровно на границе лимита 500, чтобы поймать и обрезание, и цикл.
      await sql`
        INSERT INTO deliveries (id, site_id, inspector_id, status_id, version, created_at, updated_at)
        SELECT gen_random_uuid(), ${siteA}, ${inspectorA}, ${filledStatusId}, 1,
               now() - ${`${OLD_DAYS} days`}::interval, now() - ${`${OLD_DAYS} days`}::interval
        FROM generate_series(1, 501)`;
      // Плюс одна старая ЗАВЕРШЁННАЯ — она приезжать не должна.
      await sql`
        INSERT INTO deliveries (id, site_id, inspector_id, status_id, version, created_at, updated_at)
        VALUES (gen_random_uuid(), ${siteA}, ${inspectorA}, ${confirmedStatusId}, 1,
                now() - ${`${OLD_DAYS} days`}::interval, now() - ${`${OLD_DAYS} days`}::interval)`;
    });

    it('initial-sync отдаёт незавершённые старше окна (в пределах лимита страницы)', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { id: string; status: { code: string } }[] };
      // Лимит страницы — 500; все отданные записи должны быть незавершёнными
      // (старые confirmed_mol в окно не попадают).
      expect(body.deliveries.length).toBe(500);
      expect(body.deliveries.every((d) => d.status.code === 'filled')).toBe(true);
    });

    it('дельта-sync НЕ возвращает старые незавершённые — иначе клиент листает бесконечно', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const since = new Date(Date.now() - 60 * 1000).toISOString();
      const res = await app.inject({ method: 'GET', url: `/api/v1/sync?since=${since}` });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { updatedAt: string }[] };
      // В дельту попадают только свежие правки (фикстуры, созданные сейчас).
      // Ни одна запись старше окна прийти не должна: именно их повторная
      // выдача в каждой дельте и зациклила бы клиентскую пагинацию.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const oldOnes = body.deliveries.filter((d) => new Date(d.updatedAt).getTime() < cutoff);
      expect(oldOnes).toHaveLength(0);
      expect(body.deliveries.length).toBeLessThan(500);
    });

    it('reconcile видит все незавершённые независимо от возраста — клиент дотянет хвост', async () => {
      currentUser = asInspector(inspectorA, siteA);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/reconcile',
        payload: { deliveries: [], shipments: [], sourceDocuments: [] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { deliveries: { missingOnClient: { id: string }[] } };
      // 501 старая filled + ownDelivery + sameSiteOtherAuthor (тоже filled).
      expect(body.deliveries.missingOnClient.length).toBeGreaterThanOrEqual(503);
    });
  });

  it('заглушка «не распознано» на планшет не уезжает', async () => {
    // Мобильный список приёмки отбирает документы по объекту и дате поставки,
    // без оглядки на статус. Заглушка (файл принят, тип не определён) пустая:
    // принять по ней нечего, а в «Сегодня» на планшете КПП она была бы шумом.
    // Разбирает такой файл менеджер на портале.
    const stub = randomUUID();
    const real = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         parse_error_code, original_filename)
      VALUES (${stub}, 'upd', false, 'inbound', 'manual_pdf', 'needs_resolution', ${siteA}, now(),
              'unrecognized_type', 'mystery.pdf')`;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum)
      VALUES (${real}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteA}, now(),
              'Д-9', now(), 100)`;

    currentUser = asInspector(inspectorA, siteA);
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync?windowDays=90' });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { sourceDocuments: { id: string }[] }).sourceDocuments.map(
      (d) => d.id,
    );
    expect(ids).not.toContain(stub);
    // Обычный документ того же объекта приезжает как раньше — фильтр точечный.
    expect(ids).toContain(real);
  });
});
