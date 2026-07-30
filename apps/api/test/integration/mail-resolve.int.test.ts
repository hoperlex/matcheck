/**
 * Превращение письма в пакет документов — на реальном PostgreSQL.
 *
 * Проверяется то, ради чего сделана сага: повтор не создаёт второй пакет, тот
 * же комплект на чужой объект не «прилипает» к первой площадке, а задание на
 * разбор пишется в одной транзакции с документами.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { mailMessages } from '../../src/db/schema.js';
import { contentHashOf, resolveMailMessage } from '../../src/domain/mail/resolve-message.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.resolve.local';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

suite('письмо → пакет документов (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  let copyObject: ReturnType<typeof vi.fn>;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const createdSites: string[] = [];

  async function ensureSite(id: string, code: string): Promise<void> {
    await sql`INSERT INTO sites (id, code, name) VALUES (${id}, ${code}, ${`Resolve ${code}`})`;
    createdSites.push(id);
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    await ensureSite(siteA, `RSA${Date.now() % 1000}`);
    await ensureSite(siteB, `RSB${Date.now() % 1000}`);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    await sql`DELETE FROM sites WHERE id = ANY(${createdSites})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ANY(${createdSites})`;
    await sql`DELETE FROM job_outbox`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    const [acc] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose)
      VALUES ('resolve', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document')
      RETURNING id`;
    accountId = acc!.id;
    copyObject = vi.fn().mockResolvedValue(undefined);
  });

  /** Письмо в карантине с одним пригодным вложением. */
  async function letter(hashes: string[], marker = randomUUID()): Promise<string> {
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO mail_messages (mail_account_id, message_hash, subject, status)
      VALUES (${accountId}, ${sha(marker)}, 'Объект', 'quarantined')
      RETURNING id`;
    for (const [i, h] of hashes.entries()) {
      await sql`INSERT INTO mail_attachments
          (mail_message_id, idx, filename, sniffed_mime, size_bytes, sha256, staging_s3_key, state)
        VALUES (${msg!.id}, ${i}, ${`upd-${i}.pdf`}, 'application/pdf', 1000, ${h},
          ${`mail/staging/${msg!.id}/${i}`}, 'kept')`;
    }
    return msg!.id;
  }

  const deps = () => ({ db, copyObject });

  it('письмо становится пакетом: документ, вложения и задание в очередь', async () => {
    const id = await letter([sha('file-a')]);

    const res = await resolveMailMessage(deps(), { messageId: id, siteId: siteA });

    expect(res.outcome).toBe('ingested');
    if (res.outcome !== 'ingested') return;

    const [bundle] = await sql<{ status: string; origin: string; idempotency_key: string }[]>`
      SELECT status, origin, idempotency_key FROM source_bundles WHERE id = ${res.bundleId}`;
    // Сага закрыта: пакет вышел из resolving и готов к разбору.
    expect(bundle).toMatchObject({ status: 'queued', origin: 'mail' });
    expect(bundle!.idempotency_key).toContain(siteA);

    const [doc] = await sql<{ is_technical: boolean; origin: string; bundle_id: string }[]>`
      SELECT is_technical, origin, bundle_id FROM source_documents WHERE id = ${res.documentId}`;
    // Служебная запись помечена — на планшет она не уедет.
    expect(doc).toMatchObject({ is_technical: true, origin: 'mail', bundle_id: res.bundleId });

    const atts = await sql`
      SELECT id FROM source_document_attachments WHERE source_document_id = ${res.documentId}`;
    expect(atts).toHaveLength(1);
    expect(copyObject).toHaveBeenCalledTimes(1);

    // Задание на разбор лежит в outbox — не потеряется при недоступном Redis.
    const jobs = await sql<{ dedupe_key: string; payload: { bundleId: string } }[]>`
      SELECT dedupe_key, payload FROM job_outbox`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(`bundle:${res.bundleId}:parse:0`);
    expect(jobs[0]!.payload.bundleId).toBe(res.bundleId);

    const [msg] = await sql<{ status: string; bundle_id: string }[]>`
      SELECT status, bundle_id FROM mail_messages WHERE id = ${id}`;
    expect(msg).toMatchObject({ status: 'ingested', bundle_id: res.bundleId });
  });

  it('повторный вызов не создаёт второй пакет', async () => {
    const id = await letter([sha('file-b')]);
    const first = await resolveMailMessage(deps(), { messageId: id, siteId: siteA });
    copyObject.mockClear();

    const second = await resolveMailMessage(deps(), { messageId: id, siteId: siteA });

    expect(second.outcome).toBe('reused');
    if (second.outcome === 'reused' && first.outcome === 'ingested') {
      expect(second.bundleId).toBe(first.bundleId);
    }
    // Файлы второй раз не копируются.
    expect(copyObject).not.toHaveBeenCalled();
    const bundles = await sql`SELECT id FROM source_bundles WHERE site_id = ${siteA}`;
    expect(bundles).toHaveLength(1);
  });

  it('тот же комплект на ДРУГОЙ объект уходит в разбор, а не к чужому пакету', async () => {
    // Это тот самый дефект: уникальность держится на хеше файлов без учёта
    // объекта, поэтому второй объект молча получил бы пакет первого.
    const same = sha('file-shared');
    const first = await letter([same]);
    const firstRes = await resolveMailMessage(deps(), { messageId: first, siteId: siteA });
    expect(firstRes.outcome).toBe('ingested');

    const second = await letter([same]);
    const res = await resolveMailMessage(deps(), { messageId: second, siteId: siteB });

    expect(res.outcome).toBe('cross_scope');
    const [msg] = await sql<{ status: string; reject_reason: string }[]>`
      SELECT status, reject_reason FROM mail_messages WHERE id = ${second}`;
    // Письмо осталось в карантине — решать оператору.
    expect(msg).toMatchObject({ status: 'quarantined', reject_reason: 'cross_scope_conflict' });
    const bundles = await sql`SELECT id FROM source_bundles WHERE site_id = ${siteB}`;
    expect(bundles).toHaveLength(0);
  });

  it('тот же комплект на ТОТ ЖЕ объект переиспользует пакет', async () => {
    const same = sha('file-repeat');
    const first = await letter([same]);
    const firstRes = await resolveMailMessage(deps(), { messageId: first, siteId: siteA });

    const second = await letter([same]);
    const res = await resolveMailMessage(deps(), { messageId: second, siteId: siteA });

    expect(res.outcome).toBe('reused');
    if (res.outcome === 'reused' && firstRes.outcome === 'ingested') {
      expect(res.bundleId).toBe(firstRes.bundleId);
    }
    // Оба письма привязаны к одному пакету, provenance записан дважды.
    const events = await sql`SELECT id FROM ingest_events WHERE bundle_id = ${res.outcome === 'reused' ? res.bundleId : ''}`;
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('письмо без пригодных вложений пакет не создаёт', async () => {
    const id = await letter([]);
    const res = await resolveMailMessage(deps(), { messageId: id, siteId: siteA });
    expect(res.outcome).toBe('no_attachments');
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('сбой копирования не оставляет готовый пакет', async () => {
    copyObject.mockRejectedValueOnce(new Error('S3 недоступен'));
    const id = await letter([sha('file-fail')]);

    await expect(resolveMailMessage(deps(), { messageId: id, siteId: siteA })).rejects.toThrow(
      'S3 недоступен',
    );

    // Пакет остался в resolving: в списках загрузок он не появляется, а письмо
    // не помечено принятым.
    const [bundle] = await sql<{ status: string }[]>`
      SELECT status FROM source_bundles WHERE site_id = ${siteA}`;
    expect(bundle!.status).toBe('resolving');
    const [msg] = await sql<{ status: string }[]>`
      SELECT status FROM mail_messages WHERE id = ${id}`;
    expect(msg!.status).toBe('resolving');
    // Документов и заданий не появилось.
    expect(await sql`SELECT id FROM source_documents WHERE site_id = ${siteA}`).toHaveLength(0);
    expect(await sql`SELECT id FROM job_outbox`).toHaveLength(0);
  });

  it('отклонённое письмо принять нельзя', async () => {
    const id = await letter([sha('file-rejected')]);
    await db.update(mailMessages).set({ status: 'rejected' }).where(eq(mailMessages.id, id));

    const res = await resolveMailMessage(deps(), { messageId: id, siteId: siteA });

    expect(res.outcome).toBe('not_quarantined');
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteA}`).toHaveLength(0);
  });

  it('несуществующее письмо не создаёт пакет', async () => {
    const res = await resolveMailMessage(deps(), { messageId: randomUUID(), siteId: siteA });
    expect(res.outcome).toBe('not_quarantined');
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('хеш содержимого не зависит от порядка файлов', () => {
    const a = sha('one');
    const b = sha('two');
    expect(contentHashOf([a, b])).toBe(contentHashOf([b, a]));
  });
});
