/**
 * Пути Диадока закрыты от учёток другого оператора — на настоящем PostgreSQL.
 *
 * Зачем. В edo_accounts появится учётка СБИС. До этого ни один путь Диадока не
 * смотрел на `provider`: автовыгрузка взяла бы её в обход, построила клиент
 * Диадока с чужими ключами, записала курсор и `running`-строку журнала и
 * каждые полчаса слала бы ошибку. Обещание этого набора: учётка не-Диадока
 * не видна ни одной выборке Диадока, а прямой вызов по её id отказывает ДО
 * лиза, курсора, журнала и клиента.
 *
 * Фикстура: `provider='sbis'` с `auth_mode='developer_key'` — сочетание, которое
 * проходит сегодняшние CHECK. Когда миграция свяжет СБИС с собственным режимом
 * входа, фикстура меняется осознанно (план этапа Р, выпуск Р2).
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { edoAccounts, edoExportCursors, edoExportRuns } from '../../src/db/schema.js';
import { checkEdoAccess } from '../../src/domain/edo/check-access.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import { runEdoDryRun } from '../../src/domain/edo/dry-run.js';
import { listPollableEdoAccounts } from '../../src/domain/edo/poll-lease.js';
import {
  exportRegistryStatus,
  listExportAccounts,
  runEdoExportPass,
  runExportForAllAccounts,
} from '../../src/domain/jobs/edo-export-runner.js';
import { pollEdoAccount } from '../../src/domain/jobs/edo-poll.js';
import { runEdoInventory, runWithEdoClient } from '../../src/domain/jobs/edo-poll-runner.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import { edoAccountRoutes } from '../../src/routes/admin/edo-accounts.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Клиент Диадока с пустой лентой: пусть проход Диадока пройдёт, не трогая сеть. */
function emptyDiadoc(): DiadocClient {
  return {
    getNewEvents: vi.fn(async () => ({ events: [] })),
    getEntityContent: vi.fn(),
    getMessage: vi.fn(),
  } as unknown as DiadocClient;
}

suite('пути Диадока закрыты от учёток другого оператора (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let app: FastifyInstance;
  const queueAdd = vi.fn(async () => ({ id: 'job-1' }));
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
  const created: string[] = [];

  let diadocId: string;
  let sbisId: string;

  async function account(id: string) {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, id));
    return row!;
  }

  async function sideEffects(id: string) {
    const cursors = await db.select().from(edoExportCursors).where(eq(edoExportCursors.edoAccountId, id));
    const runs = await db.select().from(edoExportRuns).where(eq(edoExportRuns.edoAccountId, id));
    const row = await account(id);
    return { cursors: cursors.length, runs: runs.length, leaseToken: row.pollLeaseToken };
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('queues', { edoPoll: { add: queueAdd } } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = { id: randomUUID(), role: 'admin', siteId: null } as unknown as AuthUser;
    });
    app.decorate('authorize', () => async () => {});
    await app.register(edoAccountRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (created.length) await db.delete(edoAccounts).where(inArray(edoAccounts.id, created));
    await app?.close();
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    queueAdd.mockClear();
    diadocId = randomUUID();
    sbisId = randomUUID();
    created.push(diadocId, sbisId);
    // Имена с префиксом «0» — эти учётки идут первыми в упорядоченном проходе.
    await db.insert(edoAccounts).values([
      {
        id: diadocId,
        name: `0-диадок-${diadocId.slice(0, 8)}`,
        credentialsEncrypted: '{}',
        boxId: 'box-диадок',
        pollEnabled: true,
      },
      {
        id: sbisId,
        name: `0-сбис-${sbisId.slice(0, 8)}`,
        provider: 'sbis',
        authMode: 'developer_key',
        credentialsEncrypted: '{}',
        boxId: 'org-сбис',
        pollEnabled: true,
      },
    ]);
  });

  it('выборки Диадока не видят учётку другого оператора', async () => {
    const pollable = (await listPollableEdoAccounts(db)).map((a) => a.id);
    expect(pollable).toContain(diadocId);
    expect(pollable).not.toContain(sbisId);

    const exportable = (await listExportAccounts(db)).map((a) => a.id);
    expect(exportable).toContain(diadocId);
    expect(exportable).not.toContain(sbisId);

    const registry = (await exportRegistryStatus(db, { intervalSec: 1800 })).map((a) => a.accountId);
    expect(registry).toContain(diadocId);
    expect(registry).not.toContain(sbisId);
  });

  it('выгрузка по id учётки не-Диадока отказывает до лиза, курсора и журнала', async () => {
    const createClient = vi.fn(() => emptyDiadoc());
    const result = await runEdoExportPass(
      { db, log, owner: randomUUID(), createClient, put: vi.fn() },
      sbisId,
      { scope: 'all', trigger: 'auto', maxEvents: 10, maxDownloads: 10 },
    );
    expect(result).toEqual({ skipped: 'provider' });
    expect(createClient).not.toHaveBeenCalled();
    expect(await sideEffects(sbisId)).toEqual({ cursors: 0, runs: 0, leaseToken: null });
  });

  it('опрос, осмотр и сессия клиента считают учётку не-Диадока несуществующей', async () => {
    const createClient = vi.fn(() => emptyDiadoc());
    const deps = { db, log, owner: randomUUID(), createClient };

    expect(await pollEdoAccount(deps, sbisId, { manual: true })).toMatchObject({ skipped: 'not_found' });
    expect(await runEdoInventory(deps, sbisId)).toMatchObject({ skipped: 'not_found' });
    const fn = vi.fn();
    expect(await runWithEdoClient(deps, sbisId, fn)).toEqual({ skipped: 'not_found' });
    expect(fn).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect((await sideEffects(sbisId)).leaseToken).toBeNull();
  });

  it('проверка доступа и пробный разбор отказывают 409 без лиза', async () => {
    const row = await account(sbisId);
    expect(await checkEdoAccess(db, row, log)).toMatchObject({ error: 'provider_not_supported', status: 409 });
    const createClient = vi.fn(() => emptyDiadoc());
    expect(await runEdoDryRun(db, row, log, { createClient })).toMatchObject({
      error: 'provider_not_supported',
      status: 409,
    });
    expect(createClient).not.toHaveBeenCalled();
    expect((await sideEffects(sbisId)).leaseToken).toBeNull();
  });

  it('админка: действия Диадока для учётки другого оператора — 409, в очередь ничего не ставится', async () => {
    for (const url of [`/api/v1/admin/edo-accounts/${sbisId}/sync`, `/api/v1/admin/edo-accounts/${sbisId}/inventory`]) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(409);
      expect(res.json()).toMatchObject({ error: 'provider_not_supported' });
    }
    for (const action of ['check', 'dry-run']) {
      const res = await app.inject({ method: 'POST', url: `/api/v1/admin/edo-accounts/${sbisId}/${action}`, payload: {} });
      expect(res.statusCode, action).toBe(409);
      expect(res.json()).toMatchObject({ error: 'provider_not_supported' });
    }
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/edo-accounts/${sbisId}`,
      payload: { pollEnabled: true },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({ error: 'provider_not_supported' });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('автопроход: сбой одной учётки не срывает остальные, учётку не-Диадока не трогает', async () => {
    // Вторая учётка Диадока, после первой по имени.
    const laterId = randomUUID();
    created.push(laterId);
    await db.insert(edoAccounts).values({
      id: laterId,
      name: `0-диадок-я-${laterId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: 'box-второй',
    });

    const seen: string[] = [];
    const createClient = vi.fn((acc: typeof edoAccounts.$inferSelect) => {
      seen.push(acc.id);
      // Сломанные реквизиты первой учётки: клиент не строится.
      if (acc.id === diadocId) throw new Error('реквизиты повреждены');
      return emptyDiadoc();
    });
    const onError = vi.fn(() => {
      // Даже если отчёт об ошибке сам падает, проход идёт к следующей учётке.
      throw new Error('Sentry недоступен');
    });
    const onCrash = vi.fn();

    await runExportForAllAccounts(
      { db, log, owner: randomUUID(), createClient, put: vi.fn() },
      { maxEvents: 10, maxDownloads: 10 },
      { onError, onStuck: vi.fn(), onCrash },
    );

    expect(seen).toContain(diadocId);
    expect(seen).toContain(laterId);
    expect(seen).not.toContain(sbisId);
    expect(onError).toHaveBeenCalledWith(diadocId, expect.objectContaining({ outcome: 'error' }));
    expect(onCrash).toHaveBeenCalledWith(diadocId, expect.any(Error));

    // Сбой построения клиента закрыт в журнале как error, а не оставлен `running`.
    const runs = await db
      .select({ outcome: edoExportRuns.outcome, error: edoExportRuns.error })
      .from(edoExportRuns)
      .where(eq(edoExportRuns.edoAccountId, diadocId));
    expect(runs).toEqual([{ outcome: 'error', error: 'реквизиты повреждены' }]);
    const [laterRun] = await db
      .select({ outcome: edoExportRuns.outcome })
      .from(edoExportRuns)
      .where(and(eq(edoExportRuns.edoAccountId, laterId)));
    expect(laterRun).toEqual({ outcome: 'completed' });
    expect(await sideEffects(sbisId)).toEqual({ cursors: 0, runs: 0, leaseToken: null });
  });
});
