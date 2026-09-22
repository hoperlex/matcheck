/**
 * Ретенция служебных журналов распознавания.
 *
 * Проверяется на реальном PostgreSQL, потому что вся суть правила — в SQL:
 * граница срока, батчи с потолком и условие «пакет в терминальном состоянии».
 * Последнее важнее остального: по `page_classification` считается откат сборки
 * и аудит нумерации, и улика живого пакета не имеет права исчезнуть, сколько
 * бы дней ей ни было.
 *
 * Запуск: см. заголовок test/integration/qty-repair.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const { cleanupRecognitionLogs, RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES } = await import(
  '../../src/domain/jobs/log-retention.js'
);

suite('ретенция журналов распознавания (реальный PostgreSQL)', () => {
  const db = sql!;
  const drz = TEST_DATABASE_URL ? drizzle(sql!) : ({} as never);
  const marker = `retention-${Date.now()}`;

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM llm_calls WHERE doc_kind = ${marker}`;
    await db`DELETE FROM recognition_evidence_events WHERE evidence_type = ${marker}`;
    await db`DELETE FROM source_bundles WHERE bundle_hash LIKE ${marker + '%'}`;
  }

  beforeEach(cleanup);

  async function seedBundle(status: string): Promise<string> {
    const id = randomUUID();
    await db`INSERT INTO source_bundles (id, direction, status, bundle_hash, doc_count)
             VALUES (${id}, 'inbound', ${status}, ${`${marker}-${id}`}, 0)`;
    return id;
  }

  async function seedCall(ageDays: number): Promise<string> {
    const id = randomUUID();
    await db`INSERT INTO llm_calls (id, doc_kind, request_messages, latency_ms, created_at)
             VALUES (${id}, ${marker}, '[]'::jsonb, 1,
                     now() - make_interval(days => ${ageDays}))`;
    return id;
  }

  async function seedEvidence(bundleId: string, ageDays: number): Promise<string> {
    const id = randomUUID();
    await db`INSERT INTO recognition_evidence_events
               (id, bundle_id, generation, evidence_type, payload, created_at)
             VALUES (${id}, ${bundleId}, 0, ${marker}, '{}'::jsonb,
                     now() - make_interval(days => ${ageDays}))`;
    return id;
  }

  const callExists = async (id: string): Promise<boolean> =>
    (await db`SELECT 1 FROM llm_calls WHERE id = ${id}`).length > 0;
  const evidenceExists = async (id: string): Promise<boolean> =>
    (await db`SELECT 1 FROM recognition_evidence_events WHERE id = ${id}`).length > 0;

  it('ноль дней — не удаляется ничего (поведение по умолчанию)', async () => {
    const old = await seedCall(400);
    const bundle = await seedBundle('parsed');
    const oldEvidence = await seedEvidence(bundle, 400);

    const res = await cleanupRecognitionLogs({ db: drz, llmCallsDays: 0, evidenceDays: 0 });

    expect(res).toMatchObject({ llmCallsDeleted: 0, evidenceDeleted: 0 });
    expect(await callExists(old)).toBe(true);
    expect(await evidenceExists(oldEvidence)).toBe(true);
  });

  it('граница срока: запись моложе порога остаётся, старше — удаляется', async () => {
    const young = await seedCall(89);
    const old = await seedCall(91);

    const res = await cleanupRecognitionLogs({ db: drz, llmCallsDays: 90, evidenceDays: 0 });

    expect(res.llmCallsDeleted).toBe(1);
    expect(await callExists(young)).toBe(true);
    expect(await callExists(old)).toBe(false);
  });

  it('улика живого пакета не удаляется независимо от возраста', async () => {
    const queued = await seedBundle('queued');
    const processing = await seedBundle('processing');
    const done = await seedBundle('parsed');
    const failed = await seedBundle('parse_failed');
    const keptQueued = await seedEvidence(queued, 400);
    const keptProcessing = await seedEvidence(processing, 400);
    const removedDone = await seedEvidence(done, 400);
    const removedFailed = await seedEvidence(failed, 400);

    const res = await cleanupRecognitionLogs({ db: drz, llmCallsDays: 0, evidenceDays: 180 });

    expect(res.evidenceDeleted).toBe(2);
    expect(await evidenceExists(keptQueued)).toBe(true);
    expect(await evidenceExists(keptProcessing)).toBe(true);
    expect(await evidenceExists(removedDone)).toBe(false);
    expect(await evidenceExists(removedFailed)).toBe(false);
  });

  it('незавершённый дочерний пакет защищает улику корня', async () => {
    const root = await seedBundle('parsed');
    const child = randomUUID();
    await db`INSERT INTO source_bundles (id, direction, status, bundle_hash, doc_count, parent_bundle_id)
             VALUES (${child}, 'inbound', 'processing', ${`${marker}-${child}`}, 0, ${root})`;
    const kept = await seedEvidence(root, 400);

    const res = await cleanupRecognitionLogs({ db: drz, llmCallsDays: 0, evidenceDays: 180 });

    expect(res.evidenceDeleted).toBe(0);
    expect(await evidenceExists(kept)).toBe(true);
  });

  it('потолок батчей: прогон завершается штатно и оставляет остаток на следующий раз', async () => {
    // Ровно на один батч больше потолка — проверяем именно ограничение, а не
    // объём: сажать 50 000 строк в тест бессмысленно долго.
    const total = RETENTION_BATCH_SIZE * 2 + 1;
    await db`INSERT INTO llm_calls (id, doc_kind, request_messages, latency_ms, created_at)
             SELECT gen_random_uuid(), ${marker}, '[]'::jsonb, 1, now() - interval '200 days'
             FROM generate_series(1, ${total})`;

    const first = await cleanupRecognitionLogs({ db: drz, llmCallsDays: 90, evidenceDays: 0 });
    expect(first.llmCallsDeleted).toBe(total);
    expect(first.llmCallsCapped).toBe(false);
    expect(RETENTION_MAX_BATCHES).toBeGreaterThan(2);

    const [{ count }] = await db<{ count: string }[]>`
      SELECT count(*)::text AS count FROM llm_calls WHERE doc_kind = ${marker}`;
    expect(Number(count)).toBe(0);
  });
});
