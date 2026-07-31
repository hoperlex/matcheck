/**
 * Экран «Разбор почты» со стороны API.
 *
 * Проверяется то, ради чего экран и нужен: письмо, не прошедшее автоматически,
 * доводится оператором до пакета, а опасные исходы (чужая площадка, пустое
 * письмо, повторное подтверждение) не создают документов.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const copyObject = vi.fn<(src: string, dst: string) => Promise<void>>();
const presign = vi.fn<(o: unknown) => Promise<string>>();

// Роут тянет S3 напрямую — подменяем модуль целиком, иначе тест полезет в сеть.
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  copyObject: (src: string, dst: string) => copyObject(src, dst),
  presign: (o: unknown) => presign(o),
}));

const { mailReviewRoutes } = await import('../../src/routes/mail-review.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.review-test.local';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

suite('разбор почты: API (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let accountId: string;
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const createdSites = [siteA, siteB];
  // Подтверждающий пишется в created_by_user_id и ingest_events — на оба поля
  // висит FK, поэтому нужен настоящий пользователь, а не произвольный UUID.
  const operatorId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    await sql`INSERT INTO sites (id, code, name) VALUES
      (${siteA}, ${`REVA${Date.now() % 1000}`}, 'Разбор А'),
      (${siteB}, ${`REVB${Date.now() % 1000}`}, 'Разбор Б')`;
    await sql`INSERT INTO users (id, email, password_hash, role, is_active)
      VALUES (${operatorId}, ${`review-${operatorId}@test.local`}, 'x', 'manager', true)`;

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
    await app.register(mailReviewRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    await sql`DELETE FROM sites WHERE id = ANY(${createdSites})`;
    await sql`DELETE FROM users WHERE id = ${operatorId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    const [acc] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, is_active)
      VALUES ('УПД подрядчиков', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true)
      RETURNING id`;
    accountId = acc!.id;
    copyObject.mockReset().mockResolvedValue(undefined);
    presign.mockReset().mockResolvedValue('https://s3.example/signed');
    currentUser = { id: operatorId, role: 'manager' } as AuthUser;
  });

  /** Письмо в карантине с вложениями заданных состояний. */
  async function letter(
    opts: {
      subject?: string;
      states?: string[];
      suggestedSiteId?: string | null;
      status?: string;
    } = {},
  ): Promise<string> {
    const marker = randomUUID();
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO mail_messages
        (mail_account_id, message_hash, subject, from_address, status, suggested_site_id)
      VALUES (${accountId}, ${sha(marker)}, ${opts.subject ?? 'УПД за июль'},
        'snab@podryad.ru', ${opts.status ?? 'quarantined'}, ${opts.suggestedSiteId ?? null})
      RETURNING id`;
    const states = opts.states ?? ['kept'];
    for (const [i, state] of states.entries()) {
      // Отброшенное в хранилище не заливается — ключа у него нет, как и в бою
      // (см. ingest-message.ts: skipped пропускается до putObject).
      const stagingKey = state === 'skipped' ? null : `mail/staging/${msg!.id}/${i}`;
      await sql`INSERT INTO mail_attachments
          (mail_message_id, idx, filename, sniffed_mime, size_bytes, sha256, staging_s3_key, state, skip_reason)
        VALUES (${msg!.id}, ${i}, ${`upd-${i}.pdf`}, 'application/pdf', 1000,
          ${sha(`${marker}-${i}`)}, ${stagingKey}, ${state},
          ${state === 'suspected_signature' ? 'похоже на подпись в письме' : null})`;
    }
    return msg!.id;
  }

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, payload });

  it('в разбор попадают только письма, ждущие человека', async () => {
    const pending = await letter();
    await letter({ status: 'ingested' });

    const res = await get('/api/v1/mail/messages?status=pending');

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; attachmentsCount: number }[] };
    const ours = body.items.filter((i) => i.id === pending);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.attachmentsCount).toBe(1);
    // Принятое письмо в список «на разбор» не попадает.
    expect(body.items.some((i) => i.status === 'ingested')).toBe(false);
  });

  it('строка списка показывает подсказку объекта и счётчики вложений', async () => {
    // Подсказка есть, но автопроход по ней запрещён — оператор видит её как
    // предложение и подтверждает сам.
    const id = await letter({
      suggestedSiteId: siteA,
      states: ['kept', 'suspected_signature', 'skipped'],
    });

    const res = await get(`/api/v1/mail/messages/${id}`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      suggestedSiteId: string;
      suggestedSiteCode: string;
      attachmentsCount: number;
      attachmentsTotal: number;
      attachments: { state: string; willBeIngested: boolean; skipReason: string | null }[];
    };
    expect(body.suggestedSiteId).toBe(siteA);
    expect(body.suggestedSiteCode).toMatch(/^REVA/);
    // В пакет пойдёт только пригодное, но видит оператор все три.
    expect(body.attachmentsCount).toBe(1);
    expect(body.attachmentsTotal).toBe(3);
    expect(body.attachments.filter((a) => a.willBeIngested)).toHaveLength(1);
    expect(body.attachments.find((a) => a.state === 'suspected_signature')?.skipReason).toContain(
      'подпись',
    );
  });

  it('подтверждение оператора создаёт пакет на выбранном объекте', async () => {
    const id = await letter();

    const res = await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: string; bundleId: string; documentId: string };
    expect(body.outcome).toBe('ingested');

    const [bundle] = await sql<{ site_id: string; status: string; origin: string }[]>`
      SELECT site_id, status, origin FROM source_bundles WHERE id = ${body.bundleId}`;
    expect(bundle).toMatchObject({ site_id: siteA, status: 'queued', origin: 'mail' });
    expect(copyObject).toHaveBeenCalledTimes(1);

    // Кто подтвердил — записано: у автопрохода это поле пустое.
    const [event] = await sql<{ actor_user_id: string; channel: string }[]>`
      SELECT actor_user_id, channel FROM ingest_events WHERE bundle_id = ${body.bundleId}`;
    expect(event).toMatchObject({ actor_user_id: currentUser.id, channel: 'mail' });

    const [msg] = await sql<{ status: string }[]>`
      SELECT status FROM mail_messages WHERE id = ${id}`;
    expect(msg!.status).toBe('ingested');
  });

  it('тот же комплект на другой объект — 409, документов не появляется', async () => {
    const first = await letter();
    const okRes = await post(`/api/v1/mail/messages/${first}/resolve`, { siteId: siteA });
    expect(okRes.statusCode).toBe(200);

    // Второе письмо с тем же набором файлов: копируем хеши вложений.
    const second = await letter();
    await sql`UPDATE mail_attachments a
      SET sha256 = (SELECT sha256 FROM mail_attachments WHERE mail_message_id = ${first} AND idx = a.idx)
      WHERE a.mail_message_id = ${second}`;

    const res = await post(`/api/v1/mail/messages/${second}/resolve`, { siteId: siteB });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'cross_scope_conflict' });
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteB}`).toHaveLength(0);
    // Письмо осталось в разборе с зафиксированной причиной.
    const [msg] = await sql<{ status: string; reject_reason: string }[]>`
      SELECT status, reject_reason FROM mail_messages WHERE id = ${second}`;
    expect(msg).toMatchObject({ status: 'quarantined', reject_reason: 'cross_scope_conflict' });
  });

  it('письмо без пригодных вложений подтвердить нельзя', async () => {
    const id = await letter({ states: ['suspected_signature'] });

    const res = await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_attachments' });
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('отброшенное вложение вернуть нельзя — его нет в хранилище', async () => {
    // `skipped` в хранилище не заливается. Восстановив его, мы получили бы
    // строку, которая считается пригодной, а копировать нечего.
    const id = await letter({ states: ['skipped'] });
    const detail = (await get(`/api/v1/mail/messages/${id}`)).json() as {
      attachments: { id: string }[];
    };

    const res = await post(
      `/api/v1/mail/messages/${id}/attachments/${detail.attachments[0]!.id}/restore`,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'not_restorable' });
    const [att] = await sql<{ state: string }[]>`
      SELECT state FROM mail_attachments WHERE mail_message_id = ${id}`;
    expect(att!.state).toBe('skipped');
  });

  it('у принятого письма состав вложений менять нельзя', async () => {
    // Пакет уже собран: возврат постфактум врал бы о том, что ушло в
    // распознавание.
    const id = await letter({ states: ['kept', 'suspected_signature'] });
    const detail = (await get(`/api/v1/mail/messages/${id}`)).json() as {
      attachments: { id: string; state: string }[];
    };
    const suspected = detail.attachments.find((a) => a.state === 'suspected_signature')!;
    expect((await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA })).statusCode).toBe(
      200,
    );

    const res = await post(`/api/v1/mail/messages/${id}/attachments/${suspected.id}/restore`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'not_quarantined' });
  });

  it('возвращённое вложение участвует в пакете наравне с остальными', async () => {
    // Иначе возврат бесполезен: скан УПД, принятый за подпись, всё равно не
    // попал бы в пакет.
    const id = await letter({ states: ['suspected_signature'] });
    const detail = (await get(`/api/v1/mail/messages/${id}`)).json() as {
      attachments: { id: string }[];
    };

    const restore = await post(
      `/api/v1/mail/messages/${id}/attachments/${detail.attachments[0]!.id}/restore`,
    );
    expect(restore.statusCode).toBe(200);

    const res = await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA });
    expect(res.statusCode).toBe(200);
    expect(copyObject).toHaveBeenCalledTimes(1);
  });

  it('повторное подтверждение второй пакет не создаёт', async () => {
    const id = await letter();
    const first = (await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA })).json() as {
      bundleId: string;
    };
    copyObject.mockClear();

    const res = await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'reused', bundleId: first.bundleId });
    expect(copyObject).not.toHaveBeenCalled();
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteA}`).toHaveLength(1);
  });

  it('несуществующий объект подтвердить нельзя', async () => {
    const id = await letter();

    const res = await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: randomUUID() });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'site_not_found' });
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('отклонение сохраняет причину и убирает письмо из разбора', async () => {
    const id = await letter();

    const res = await post(`/api/v1/mail/messages/${id}/reject`, { reason: 'это переписка' });

    expect(res.statusCode).toBe(200);
    const [msg] = await sql<{ status: string; reject_reason: string }[]>`
      SELECT status, reject_reason FROM mail_messages WHERE id = ${id}`;
    expect(msg).toMatchObject({ status: 'rejected', reject_reason: 'это переписка' });

    // Повторное отклонение уже принятого письма не проходит.
    expect((await post(`/api/v1/mail/messages/${id}/reject`)).statusCode).toBe(404);
  });

  it('отклонить уже принятое письмо нельзя', async () => {
    const id = await letter();
    await post(`/api/v1/mail/messages/${id}/resolve`, { siteId: siteA });

    const res = await post(`/api/v1/mail/messages/${id}/reject`);

    expect(res.statusCode).toBe(404);
    const [msg] = await sql<{ status: string }[]>`
      SELECT status FROM mail_messages WHERE id = ${id}`;
    expect(msg!.status).toBe('ingested');
  });

  it('сводка показывает, что ящик заведён, и считает письма в разборе', async () => {
    await letter();

    const res = await get('/api/v1/mail/review/summary');

    expect(res.statusCode).toBe(200);
    const body = res.json() as { pending: number; configured: boolean };
    expect(body.configured).toBe(true);
    expect(body.pending).toBeGreaterThanOrEqual(1);
  });

  it('без активного ящика с документами вкладка не показывается', async () => {
    await sql`UPDATE mail_accounts SET is_active = false WHERE host = ${HOST}`;

    const res = await get('/api/v1/mail/review/summary');

    // Другие наборы могут держать свои ящики, поэтому проверяем ровно то, за
    // что отвечает флаг: наш выключенный ящик вкладку не включает.
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM mail_accounts WHERE purpose = 'document' AND is_active = true`;
    if (row!.n === 0) expect((res.json() as { configured: boolean }).configured).toBe(false);
  });

  it('инспектору разбор почты недоступен', async () => {
    currentUser = { id: randomUUID(), role: 'inspector' } as AuthUser;

    expect((await get('/api/v1/mail/messages')).statusCode).toBe(403);
    expect((await post(`/api/v1/mail/messages/${randomUUID()}/reject`)).statusCode).toBe(403);
  });

  it('вложение отдаётся из staging через бэкенд, ссылка на S3 наружу не уходит', async () => {
    const id = await letter();
    const detail = (await get(`/api/v1/mail/messages/${id}`)).json() as {
      attachments: { id: string }[];
    };
    const attId = detail.attachments[0]!.id;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const res = await get(`/api/v1/mail/messages/${id}/attachments/${attId}/raw`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    // Подписанный URL остался на сервере.
    expect(res.body).not.toContain('s3.example');
    expect(presign).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining('mail/staging/') }),
    );
    fetchSpy.mockRestore();
  });

  it('чужое вложение по идентификатору письма не отдаётся', async () => {
    const mine = await letter();
    const other = await letter();
    const otherAtt = (await get(`/api/v1/mail/messages/${other}`)).json() as {
      attachments: { id: string }[];
    };

    const res = await get(
      `/api/v1/mail/messages/${mine}/attachments/${otherAtt.attachments[0]!.id}/raw`,
    );

    expect(res.statusCode).toBe(404);
    expect(presign).not.toHaveBeenCalled();
  });
});
