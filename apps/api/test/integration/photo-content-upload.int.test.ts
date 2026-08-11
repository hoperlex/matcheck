/**
 * POST /api/v1/photos/:id/content — загрузка файла фото через API-прокси
 * (браузер → наш домен → S3), появившаяся потому, что у бакета нет CORS-правила
 * для origin портала и прямой PUT из браузера не проходит preflight.
 *
 * S3 замокан: проверяем не только скоуп, но и суть — что объект уходит по
 * s3Key записи, что uploaded_at проставляется, и что в гонках мы не удаляем
 * чужой файл. Реальный PostgreSQL нужен ради условного UPDATE и транзакции.
 *
 * Запуск: см. заголовок foreign-site.int.test.ts. Без TEST_DATABASE_URL
 * набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  presign: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: mocks.putObject,
  deleteObject: mocks.deleteObject,
  presign: mocks.presign,
  getObject: mocks.getObject,
  headObject: mocks.headObject,
}));

const { photoRoutes } = await import('../../src/routes/photos.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const BOUNDARY = '----matcheckPhotoContent';

function multipartBody(
  files: Array<{ field: string; content: Buffer }>,
  fields: Record<string, string> = {},
): { body: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field}"; ` +
          `filename="${f.field}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/** Валидный по сигнатуре JPEG: FF D8 FF + хвост, уникальный на вызов. */
function jpeg(tag = 'x'): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
}
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

suite('POST /photos/:id/content — загрузка фото через API-прокси', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const inspectorA = randomUUID();
  const inspectorB = randomUUID();
  let statusId: string;
  let ownDelivery: string;
  let foreignDelivery: string;
  let pendingDeletionDelivery: string;

  const logUnauthorized = vi.fn(async () => {});

  beforeEach(() => {
    logUnauthorized.mockClear();
    mocks.putObject.mockReset().mockResolvedValue(undefined);
    mocks.deleteObject.mockReset().mockResolvedValue(undefined);
    currentUser = asInspector(inspectorA, siteA);
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
    // Лимиты как в боевом server.ts — чтобы пер-запросный оверрайд на два
    // файла проверялся по-настоящему, а не на заранее щедром дефолте.
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    await app.register(photoRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteA}, ${'PCA'}, 'PhotoContent A'), (${siteB}, ${'PCB'}, 'PhotoContent B')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id) VALUES
      (${inspectorA}, ${`pca-${inspectorA}@test`}, 'x', 'inspector_kpp', ${siteA}),
      (${inspectorB}, ${`pcb-${inspectorB}@test`}, 'x', 'inspector_kpp', ${siteB})`;
    const [st] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    statusId = st!.id;

    ownDelivery = await seedDelivery(siteA, inspectorA);
    foreignDelivery = await seedDelivery(siteB, inspectorB);
    pendingDeletionDelivery = await seedDelivery(siteA, inspectorA);
    // deliveries_pending_deletion_chk требует пару: и отметку времени, и автора.
    await sql`UPDATE deliveries
      SET pending_deletion_at = now(), pending_deletion_by_user_id = ${inspectorA}
      WHERE id = ${pendingDeletionDelivery}`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteA} OR site_id = ${siteB}`;
    await sql`DELETE FROM users WHERE id = ${inspectorA} OR id = ${inspectorB}`;
    await sql`DELETE FROM sites WHERE id = ${siteA} OR id = ${siteB}`;
    await sql.end({ timeout: 5 });
  });

  async function seedDelivery(siteId: string, inspectorId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${inspectorId}, ${statusId}, 1)`;
    return id;
  }

  /** Возвращает id фото и его s3-ключи. contentHash — под конкретный буфер. */
  async function seedPhoto(
    deliveryId: string,
    opts: { contentHash?: string; withThumb?: boolean; uploaded?: boolean } = {},
  ): Promise<{ id: string; s3Key: string; thumbS3Key: string | null }> {
    const id = randomUUID();
    const s3Key = `k/${id}.jpg`;
    const thumbS3Key = opts.withThumb === false ? null : `k/${id}-thumb.jpg`;
    await sql`INSERT INTO delivery_photos
      (id, delivery_id, kind, s3_key, thumb_s3_key, content_hash, idempotency_key,
       taken_at, uploaded_at)
      VALUES (${id}, ${deliveryId}, 'cargo', ${s3Key}, ${thumbS3Key},
              ${opts.contentHash ?? id.slice(0, 12)}, ${randomUUID()}, now(),
              ${opts.uploaded ? sql`now()` : null})`;
    return { id, s3Key, thumbS3Key };
  }

  const asInspector = (id: string, siteId: string): AuthUser => ({
    id,
    role: 'inspector_kpp',
    siteId,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  const post = (photoId: string, files: Array<{ field: string; content: Buffer }>) => {
    const { body, headers } = multipartBody(files);
    return app.inject({
      method: 'POST',
      url: `/api/v1/photos/${photoId}/content`,
      payload: body,
      headers,
    });
  };

  const photoRow = async (id: string) =>
    (
      await sql<{ uploaded_at: Date | null; thumb_s3_key: string | null }[]>`
        SELECT uploaded_at, thumb_s3_key FROM delivery_photos WHERE id = ${id}`
    )[0];

  it('несуществующее фото → 404', async () => {
    const res = await post(randomUUID(), [{ field: 'file', content: jpeg() }]);
    expect(res.statusCode).toBe(404);
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('чужой объект → 403 foreign_site + запись в журнал отказов', async () => {
    const photo = await seedPhoto(foreignDelivery);
    const res = await post(photo.id, [{ field: 'file', content: jpeg() }]);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'foreign_site' });
    expect(logUnauthorized).toHaveBeenCalledWith(
      expect.anything(),
      403,
      'photo_foreign_site',
      inspectorA,
    );
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('документ помечен на удаление → 409 pending_deletion', async () => {
    const photo = await seedPhoto(pendingDeletionDelivery);
    const res = await post(photo.id, [{ field: 'file', content: jpeg() }]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'pending_deletion' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('уже подтверждённое фото → 200 идемпотентно, S3 не трогаем', async () => {
    const photo = await seedPhoto(ownDelivery, { uploaded: true });
    const res = await post(photo.id, [{ field: 'file', content: jpeg() }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('успех: объект уходит по s3Key записи, uploaded_at и updatedAt родителя проставлены', async () => {
    const main = jpeg('main-ok');
    const thumb = jpeg('thumb-ok');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    const [before] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM deliveries WHERE id = ${ownDelivery}`;

    const res = await post(photo.id, [
      { field: 'file', content: main },
      { field: 'thumb', content: thumb },
    ]);

    expect(res.statusCode).toBe(200);
    expect(mocks.putObject).toHaveBeenCalledWith(photo.s3Key, main, 'image/jpeg');
    expect(mocks.putObject).toHaveBeenCalledWith(photo.thumbS3Key, thumb, 'image/jpeg');
    const row = await photoRow(photo.id);
    expect(row?.uploaded_at).not.toBeNull();
    expect(row?.thumb_s3_key).toBe(photo.thumbS3Key);
    const [after] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM deliveries WHERE id = ${ownDelivery}`;
    expect(new Date(after!.updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
  });

  it('миниатюра не пришла → thumb_s3_key обнулён, чтобы чтение откатилось на кадр', async () => {
    const main = jpeg('no-thumb');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    const res = await post(photo.id, [{ field: 'file', content: main }]);
    expect(res.statusCode).toBe(200);
    expect((await photoRow(photo.id))?.thumb_s3_key).toBeNull();
  });

  it('putObject миниатюры упал → кадр сохранён, thumb_s3_key обнулён', async () => {
    const main = jpeg('thumb-fail');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    mocks.putObject.mockImplementation(async (key: string) => {
      if (key === photo.thumbS3Key) throw new Error('S3 PUT thumb failed');
    });

    const res = await post(photo.id, [
      { field: 'file', content: main },
      { field: 'thumb', content: jpeg('t') },
    ]);

    expect(res.statusCode).toBe(200);
    const row = await photoRow(photo.id);
    expect(row?.uploaded_at).not.toBeNull();
    expect(row?.thumb_s3_key).toBeNull();
  });

  it('putObject кадра упал → 503, uploaded_at не проставлен', async () => {
    const main = jpeg('main-fail');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    mocks.putObject.mockRejectedValue(new Error('S3 PUT failed'));

    const res = await post(photo.id, [{ field: 'file', content: main }]);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 's3_unavailable' });
    expect((await photoRow(photo.id))?.uploaded_at).toBeNull();
  });

  it('запись удалили, пока шёл PUT → 404 и записанные объекты подчищены', async () => {
    const main = jpeg('deleted-mid');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    mocks.putObject.mockImplementation(async () => {
      await sql`DELETE FROM delivery_photos WHERE id = ${photo.id}`;
    });

    const res = await post(photo.id, [{ field: 'file', content: main }]);

    expect(res.statusCode).toBe(404);
    expect(mocks.deleteObject).toHaveBeenCalledWith(photo.s3Key);
  });

  it('конкурент подтвердил первым → 200 с его uploaded_at, объект НЕ удаляем', async () => {
    // Регрессия на слепое удаление по нулевому affectedRows: ноль строк
    // одинаково означает и «запись удалили», и «параллельный POST успел».
    const main = jpeg('race');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    mocks.putObject.mockImplementation(async () => {
      await sql`UPDATE delivery_photos SET uploaded_at = now() WHERE id = ${photo.id}`;
    });

    const res = await post(photo.id, [{ field: 'file', content: main }]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect((await photoRow(photo.id))?.uploaded_at).not.toBeNull();
  });

  it('файл не приложен → 400', async () => {
    const photo = await seedPhoto(ownDelivery);
    const res = await post(photo.id, []);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_file' });
  });

  it('не JPEG → 400', async () => {
    const photo = await seedPhoto(ownDelivery);
    const res = await post(photo.id, [{ field: 'file', content: Buffer.from('%PDF-1.4') }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unsupported_type' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('хэш не совпал с заявленным при presign → 400', async () => {
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(jpeg('expected')) });
    const res = await post(photo.id, [{ field: 'file', content: jpeg('actual') }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'content_hash_mismatch' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('часть file передана дважды → 400', async () => {
    const photo = await seedPhoto(ownDelivery);
    const res = await post(photo.id, [
      { field: 'file', content: jpeg('a') },
      { field: 'file', content: jpeg('b') },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'duplicate_part' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('неизвестная часть → 400', async () => {
    const photo = await seedPhoto(ownDelivery);
    const res = await post(photo.id, [
      { field: 'file', content: jpeg('a') },
      { field: 'whatever', content: jpeg('b') },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unexpected_part' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('слишком большая миниатюра → 413, а не 500', async () => {
    const main = jpeg('big-thumb');
    const photo = await seedPhoto(ownDelivery, { contentHash: sha256(main) });
    const bigThumb = Buffer.concat([jpeg('t'), Buffer.alloc(300 * 1024, 7)]);

    const res = await post(photo.id, [
      { field: 'file', content: main },
      { field: 'thumb', content: bigThumb },
    ]);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'file_too_large' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });

  it('кадр больше лимита парсера → 413, а не 500', async () => {
    // Ошибки лимитов @fastify/multipart несут statusCode 413, но общий
    // error-handler его игнорирует — роут обязан отвечать сам.
    const photo = await seedPhoto(ownDelivery);
    const huge = Buffer.concat([jpeg('h'), Buffer.alloc(3 * 1024 * 1024, 3)]);
    const res = await post(photo.id, [{ field: 'file', content: huge }]);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'file_too_large' });
    expect(mocks.putObject).not.toHaveBeenCalled();
  });
});
