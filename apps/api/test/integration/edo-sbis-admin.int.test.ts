/**
 * Админка учёток СБИС — на настоящем PostgreSQL, вход в СБИС подменён.
 *
 * Обещания (план этапа Р, выпуск Р2):
 *   - ключи заводятся формой и лежат в базе только шифром; наружу — «ID
 *     подключения», длины и отпечатки, но не значения;
 *   - «Проверить доступ» входит по сохранённым ключам и отдаёт организации со
 *     ссылкой для выбора; отказ ключей — 409 и текст в учётке;
 *   - организация выбирается ссылкой из проверки, ИНН берётся из неё; после
 *     начала выгрузки сменить организацию нельзя;
 *   - смена ключей — слиянием: пустое поле оставляет прежнее;
 *   - поля одного оператора к учётке другого не применяются (409);
 *   - учётку СБИС с выгруженными УПД не удалить — только отключить;
 *   - список учёток с СБИС и Диадоком рядом открывается;
 *   - база не примет СБИС без своего режима входа.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as SbisAuthModule from '../../src/domain/edo/sbis/sbis.auth.js';
import type * as SbisClientModule from '../../src/domain/edo/sbis/sbis.client.js';

// Ключ шифрования полей — до импорта модулей, которые его читают.
process.env.APP_FIELD_ENCRYPTION_KEYS ??= '{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}';
process.env.APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ??= 'v1';

const sbis = vi.hoisted(() => ({
  login: vi.fn(),
  listOurOrganizations: vi.fn(),
}));

vi.mock('../../src/domain/edo/sbis/sbis.auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SbisAuthModule>()),
  loginByKey: sbis.login,
}));
vi.mock('../../src/domain/edo/sbis/sbis.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SbisClientModule>()),
  createSbisClient: () => ({ listOurOrganizations: sbis.listOurOrganizations }),
}));

const schema = await import('../../src/db/schema.js');
const { buildAad, decryptField } = await import('../../src/domain/auth/crypto.js');
const { SbisAuthRejected } = await import('../../src/domain/edo/sbis/sbis.http.js');
const { edoAccountRoutes } = await import('../../src/routes/admin/edo-accounts.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const KEYS = {
  authMode: 'sbis_service_key',
  appClientId: '1025293145607151',
  appSecret: 'ZZTEST-app-secret-value',
  secretKey: 'ZZTEST-service-key-value-0123456789',
} as const;

const ORGS = [
  { СвЮЛ: { ИНН: '7736255508', КПП: '774550001', Название: 'СУ-10' }, ДокументооборотПодключен: 'Да' },
  { СвФЛ: { ИНН: '500100732259', Фамилия: 'Иванов' }, ДокументооборотПодключен: 'Нет' },
];
const SU10_REF = 'legal:7736255508:774550001:';

suite('админка учёток СБИС (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let app: FastifyInstance;
  const created: string[] = [];

  async function createSbis(name = `СБИС ${randomUUID().slice(0, 8)}`) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/edo-accounts',
      payload: { provider: 'sbis', name, credentials: KEYS },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string } & Record<string, unknown>;
    created.push(body.id);
    return body;
  }

  async function storedKeys(id: string) {
    const [row] = await sql<{ c: string }[]>`SELECT credentials_encrypted AS c FROM edo_accounts WHERE id = ${id}`;
    return JSON.parse(decryptField(row!.c, buildAad('edo_accounts', id))) as Record<string, string>;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('queues', { edoPoll: { add: vi.fn() } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = { id: randomUUID(), role: 'admin', siteId: null } as unknown as AuthUser;
    });
    app.decorate('authorize', () => async () => {});
    await app.register(edoAccountRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    if (created.length) {
      await sql`DELETE FROM edo_export_cursors WHERE edo_account_id IN ${sql(created)}`;
      await sql`DELETE FROM edo_export_documents WHERE edo_account_id IN ${sql(created)}`;
      await sql`DELETE FROM edo_accounts WHERE id IN ${sql(created)}`;
    }
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    sbis.login.mockReset();
    sbis.listOurOrganizations.mockReset();
    sbis.login.mockResolvedValue({ token: 'session-token' });
    sbis.listOurOrganizations.mockResolvedValue({ orgs: ORGS, complete: true, pages: 1, stopReason: 'end' });
  });

  it('создание: ключи в базе шифром, наружу — ID подключения, длины и отпечатки', async () => {
    const dto = await createSbis();
    expect(dto).toMatchObject({
      provider: 'sbis',
      authMode: 'sbis_service_key',
      boxId: null,
      sbisAppClientId: KEYS.appClientId,
      sbisAppSecretLength: KEYS.appSecret.length,
      sbisSecretKeyLength: KEYS.secretKey.length,
    });
    expect(dto.sbisAppSecretFingerprint).toMatch(/^[0-9a-f]{8}$/);
    const raw = JSON.stringify(dto);
    expect(raw).not.toContain(KEYS.appSecret);
    expect(raw).not.toContain(KEYS.secretKey);

    const [row] = await sql<{ c: string; mode: string }[]>`
      SELECT credentials_encrypted AS c, auth_mode AS mode FROM edo_accounts WHERE id = ${dto.id}`;
    expect(row!.mode).toBe('sbis_service_key');
    expect(row!.c).not.toContain(KEYS.secretKey);
    expect(await storedKeys(dto.id)).toEqual(KEYS);
  });

  it('проверка доступа: вход сохранёнными ключами, организации со ссылкой; отказ ключей — 409 и текст в учётке', async () => {
    const { id } = await createSbis();
    const ok = await app.inject({ method: 'POST', url: `/api/v1/admin/edo-accounts/${id}/check`, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(sbis.login).toHaveBeenCalledWith(KEYS);
    expect(ok.json()).toEqual({
      provider: 'sbis',
      complete: true,
      organizations: [
        { ref: SU10_REF, kind: 'legal', inn: '7736255508', kpp: '774550001', branch: null, name: 'СУ-10', edo: true },
        { ref: 'person:500100732259::', kind: 'person', inn: '500100732259', kpp: null, branch: null, name: 'Иванов', edo: false },
      ],
    });
    const [afterOk] = await sql<{ ok: Date | null; err: string | null; lease: string | null }[]>`
      SELECT last_ok_at AS ok, last_error AS err, poll_lease_token AS lease FROM edo_accounts WHERE id = ${id}`;
    expect(afterOk!.ok).not.toBeNull();
    expect(afterOk!.err).toBeNull();
    expect(afterOk!.lease).toBeNull();

    sbis.login.mockRejectedValueOnce(new SbisAuthRejected(401, 'ключ отклонён'));
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/admin/edo-accounts/${id}/check`, payload: {} });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ error: 'sbis_auth_rejected' });
    const [afterFail] = await sql<{ err: string | null }[]>`SELECT last_error AS err FROM edo_accounts WHERE id = ${id}`;
    expect(afterFail!.err).toBeTruthy();
  });

  it('выбор организации: по ссылке из проверки, ИНН из неё; кривая ссылка — 409; после начала выгрузки — 409', async () => {
    const { id } = await createSbis();
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${id}`,
      payload: { boxId: '7736255508/774550001' },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ error: 'invalid_organization' });

    const chosen = await app.inject({ method: 'PATCH', url: `/api/v1/admin/edo-accounts/${id}`, payload: { boxId: SU10_REF } });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(chosen.json()).toMatchObject({ boxId: SU10_REF, orgInn: '7736255508' });

    // Выгрузка началась — курсор есть, организация закреплена.
    await sql`INSERT INTO edo_export_cursors (edo_account_id, box_id, feed_query, since)
              VALUES (${id}, ${SU10_REF}, 'sbis:changes:v1', now())`;
    const change = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${id}`,
      payload: { boxId: 'person:500100732259::' },
    });
    expect(change.statusCode).toBe(409);
    expect(change.json()).toMatchObject({ error: 'box_change_forbidden' });
  });

  it('смена ключей — слиянием; поля другого оператора — 409; пустая правка ключей — 400', async () => {
    const { id } = await createSbis();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${id}`,
      payload: { sbisCredentials: { secretKey: 'ZZTEST-new-service-key' } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await storedKeys(id)).toEqual({ ...KEYS, secretKey: 'ZZTEST-new-service-key' });

    const diadocFields = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${id}`,
      payload: { credentials: { clientSecret: 'x' } },
    });
    expect(diadocFields.statusCode).toBe(409);
    expect(diadocFields.json()).toMatchObject({ error: 'provider_mismatch' });

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${id}`,
      payload: { sbisCredentials: {} },
    });
    expect(empty.statusCode).toBe(400);

    const diadocId = randomUUID();
    created.push(diadocId);
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted) VALUES (${diadocId}, ${`Диадок ${diadocId.slice(0, 8)}`}, '{}')`;
    const sbisOnDiadoc = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${diadocId}`,
      payload: { sbisCredentials: { secretKey: 'x' } },
    });
    expect(sbisOnDiadoc.statusCode).toBe(409);
    expect(sbisOnDiadoc.json()).toMatchObject({ error: 'provider_mismatch' });

    // Список с учётками обоих операторов открывается.
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/edo-accounts' });
    expect(list.statusCode, list.body).toBe(200);
    const ids = (list.json() as { id: string; provider: string }[]).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([id, diadocId]));
  });

  it('удаление: с выгруженными УПД — 409, без них — можно', async () => {
    const withRegistry = await createSbis();
    await sql`INSERT INTO edo_export_documents
        (edo_account_id, message_id, entity_id, document_type, status, s3_key, content_sha256, received_at)
      VALUES (${withRegistry.id}, 'doc-1', 'att-1', 'УпдСчфДоп', 'stored', 'edo-export/test/x.xml',
              ${'f'.repeat(64)}, now())`;
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/admin/edo-accounts/${withRegistry.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'account_has_registry' });

    const empty = await createSbis();
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/admin/edo-accounts/${empty.id}` });
    expect(removed.statusCode).toBe(200);
  });

  it('база: СБИС только со своим режимом входа, Диадок — без него', async () => {
    await expect(
      sql`INSERT INTO edo_accounts (id, name, provider, auth_mode, credentials_encrypted)
          VALUES (${randomUUID()}, 'СБИС не тем входом', 'sbis', 'oidc_refresh', '{}')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`INSERT INTO edo_accounts (id, name, provider, auth_mode, credentials_encrypted)
          VALUES (${randomUUID()}, 'Диадок ключом СБИС', 'diadoc', 'sbis_service_key', '{}')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`INSERT INTO edo_accounts (id, name, provider, credentials_encrypted)
          VALUES (${randomUUID()}, 'Неизвестный оператор', 'kontur', '{}')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
