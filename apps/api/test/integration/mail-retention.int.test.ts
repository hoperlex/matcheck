/**
 * Срок хранения почты и повторный забор.
 *
 * Обе части эксплуатационные, но ошибка в них дорогая: уборка не должна унести
 * письмо, которое ещё ждёт человека, а повтор — не должен молча ничего не
 * делать, потому что граница ящика письмо уже перешагнула.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { clearReplayFlag, loadReplayTargets, requestReplay } from '../../src/domain/mail/replay.js';
import { purgeOldMail, purgeOldReceipts } from '../../src/domain/mail/retention.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.retention.local';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

suite('срок хранения почты и повторный забор (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    const [acc] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, last_uid, uid_validity)
      VALUES ('retention', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', 100, 7)
      RETURNING id`;
    accountId = acc!.id;
  });

  /** Письмо заданного возраста и статуса, со вложением и сырым .eml в хранилище. */
  async function letter(opts: { status: string; ageDays: number }): Promise<string> {
    const marker = randomUUID();
    const [msg] = await sql<{ id: string }[]>`
      INSERT INTO mail_messages
        (mail_account_id, message_hash, subject, status, raw_s3_key, created_at)
      VALUES (${accountId}, ${sha(marker)}, 'УПД', ${opts.status},
        ${`mail/${marker}/raw.eml`}, now() - ${`${opts.ageDays} days`}::interval)
      RETURNING id`;
    await sql`INSERT INTO mail_attachments
        (mail_message_id, idx, filename, sniffed_mime, size_bytes, sha256, staging_s3_key, state)
      VALUES (${msg!.id}, 0, 'upd.pdf', 'application/pdf', 1000, ${sha(marker + 'a')},
        ${`mail/${marker}/0`}, 'kept')`;
    return msg!.id;
  }

  /** Запись журнала забора. */
  async function receipt(opts: {
    uid: number;
    status: string;
    attempts?: number;
    ageDays?: number;
  }): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail_receipts
        (mail_account_id, uid, uid_validity, status, attempts, last_error, rfc822_size, created_at)
      VALUES (${accountId}, ${opts.uid}, 7, ${opts.status}, ${opts.attempts ?? 5},
        'boom', 99999999, now() - ${`${opts.ageDays ?? 0} days`}::interval)
      RETURNING id`;
    return row!.id;
  }

  const outboxFor = (key: string) =>
    sql<{ s3_key: string }[]>`SELECT s3_key FROM s3_cleanup_outbox WHERE s3_key = ${key}`;

  const purge = (days = 30) => purgeOldMail({ db, retentionDays: days });

  it('разобранное письмо удаляется, а его файлы уходят на удаление из хранилища', async () => {
    const id = await letter({ status: 'ingested', ageDays: 60 });
    const [att] = await sql<{ staging_s3_key: string }[]>`
      SELECT staging_s3_key FROM mail_attachments WHERE mail_message_id = ${id}`;
    const [msg] = await sql<{ raw_s3_key: string }[]>`
      SELECT raw_s3_key FROM mail_messages WHERE id = ${id}`;

    const res = await purge();

    expect(res.messages).toBeGreaterThanOrEqual(1);
    expect(await sql`SELECT id FROM mail_messages WHERE id = ${id}`).toHaveLength(0);
    // Файлы не удаляются напрямую: их ключи ставятся в очередь с ретраями.
    expect(await outboxFor(msg!.raw_s3_key)).toHaveLength(1);
    expect(await outboxFor(att!.staging_s3_key)).toHaveLength(1);

    await sql`DELETE FROM s3_cleanup_outbox WHERE s3_key IN (${msg!.raw_s3_key}, ${att!.staging_s3_key})`;
  });

  it('письмо в разборе не удаляется, сколько бы ни лежало', async () => {
    // Это главная защита уборки: карантин ждёт человека, и удалить его —
    // значит потерять документы, которые никто не завёл.
    const id = await letter({ status: 'quarantined', ageDays: 3650 });

    await purge();

    expect(await sql`SELECT id FROM mail_messages WHERE id = ${id}`).toHaveLength(1);
  });

  it('свежее разобранное письмо не трогаем', async () => {
    const id = await letter({ status: 'ingested', ageDays: 5 });

    await purge(30);

    expect(await sql`SELECT id FROM mail_messages WHERE id = ${id}`).toHaveLength(1);
  });

  it('нулевой срок хранения отключает уборку', async () => {
    const id = await letter({ status: 'ingested', ageDays: 3650 });

    const res = await purgeOldMail({ db, retentionDays: 0 });

    expect(res).toEqual({ messages: 0, objects: 0 });
    expect(await sql`SELECT id FROM mail_messages WHERE id = ${id}`).toHaveLength(1);
  });

  it('журнал забора чистится только ниже границы ящика', async () => {
    // Записи выше границы ещё участвуют в её пересчёте — удалив их, мы
    // сдвинули бы границу и потеряли письма.
    const below = await receipt({ uid: 50, status: 'parsed', ageDays: 60 });
    const above = await receipt({ uid: 150, status: 'parsed', ageDays: 60 });

    await purgeOldReceipts({ db, retentionDays: 30 });

    expect(await sql`SELECT id FROM mail_receipts WHERE id = ${below}`).toHaveLength(0);
    expect(await sql`SELECT id FROM mail_receipts WHERE id = ${above}`).toHaveLength(1);
  });

  it('запись, запрошенная к повтору, из журнала не удаляется', async () => {
    const id = await receipt({ uid: 40, status: 'fetch_failed', ageDays: 60 });
    await requestReplay(db, id);

    await purgeOldReceipts({ db, retentionDays: 30 });

    expect(await sql`SELECT id FROM mail_receipts WHERE id = ${id}`).toHaveLength(1);
  });

  it('повтор обнуляет счётчик попыток — иначе дозабор сразу упрётся в предел', async () => {
    const id = await receipt({ uid: 42, status: 'fetch_failed', attempts: 5 });

    const res = await requestReplay(db, id);

    expect(res).toMatchObject({ ok: true, uid: 42 });
    const [row] = await sql<{ attempts: number; replay_requested_at: Date; last_error: null }[]>`
      SELECT attempts, replay_requested_at, last_error FROM mail_receipts WHERE id = ${id}`;
    expect(row!.attempts).toBe(0);
    expect(row!.replay_requested_at).not.toBeNull();
    expect(row!.last_error).toBeNull();
  });

  it('успешно принятое письмо повторять нельзя', async () => {
    const id = await receipt({ uid: 43, status: 'parsed' });

    const res = await requestReplay(db, id);

    expect(res).toMatchObject({ ok: false, reason: 'not_replayable' });
    const [row] = await sql<{ replay_requested_at: Date | null }[]>`
      SELECT replay_requested_at FROM mail_receipts WHERE id = ${id}`;
    expect(row!.replay_requested_at).toBeNull();
  });

  it('исчезнувшее письмо повторять нечего', async () => {
    const id = await receipt({ uid: 44, status: 'vanished' });
    expect(await requestReplay(db, id)).toMatchObject({ ok: false, reason: 'not_replayable' });
  });

  it('несуществующая запись — not_found', async () => {
    expect(await requestReplay(db, randomUUID())).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('поллер получает запрошенные UID и только своей нумерации', async () => {
    const mine = await receipt({ uid: 45, status: 'fetch_failed' });
    await requestReplay(db, mine);
    // Запись из прежней нумерации: те же UID указывают на другие письма.
    const [old] = await sql<{ id: string }[]>`
      INSERT INTO mail_receipts (mail_account_id, uid, uid_validity, status, replay_requested_at)
      VALUES (${accountId}, 46, 6, 'fetch_failed', now())
      RETURNING id`;

    const targets = await loadReplayTargets(db, { accountId, uidValidity: 7 });

    expect(targets.map((t) => t.uid)).toEqual([45]);
    expect(targets.map((t) => t.receiptId)).not.toContain(old!.id);
  });

  it('после попытки отметка снимается — повтор не крутится вечно', async () => {
    const id = await receipt({ uid: 47, status: 'fetch_failed' });
    await requestReplay(db, id);

    await clearReplayFlag(db, id);

    expect(await loadReplayTargets(db, { accountId, uidValidity: 7 })).toHaveLength(0);
  });
});
