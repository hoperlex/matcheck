/**
 * Повторный забор письма внутри прохода поллера.
 *
 * Смысл всей затеи: письмо, сорвавшееся на скачивании, после исчерпания попыток
 * лежит НИЖЕ границы ящика, и обычный проход к нему не возвращается. Здесь
 * проверяется, что дозабор действительно достаёт такое письмо, не сдвигая
 * границу и не перечитывая соседей.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { ParsedMail } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { mailAccounts } from '../../src/db/schema.js';
import { pollMailAccount, type MailboxSession } from '../../src/domain/jobs/mail-poll.js';
import type { ImapLike } from '../../src/domain/mail/imap.fetch.js';
import { requestReplay } from '../../src/domain/mail/replay.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.replay-poll.local';
const PDF = Buffer.from('%PDF-1.4\nупд\n%%EOF\n');

/**
 * Ящик, понимающий оба вида запроса: диапазон `N:*` обычного прохода и список
 * `a,b,c` точечного дозабора. Разница существенна — именно на списке и держится
 * весь повтор.
 */
function fakeMailbox(uids: number[], opts: { sizeByUid?: Record<number, number> } = {}) {
  const requestedRanges: string[] = [];
  const client: ImapLike = {
    fetch: (range) => {
      requestedRanges.push(range);
      const wanted = range.includes(':')
        ? (uid: number) => uid >= Number(range.split(':')[0])
        : (uid: number) => range.split(',').map(Number).includes(uid);
      return (async function* () {
        for (const uid of uids) {
          if (!wanted(uid)) continue;
          yield {
            uid,
            size: opts.sizeByUid?.[uid] ?? 2000,
            envelope: { messageId: `<${uid}@x>`, subject: 'УПД' },
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { type: 'text/plain', size: 100 },
                { type: 'application/pdf', size: 1500, disposition: 'attachment' },
              ],
            },
            internalDate: new Date('2026-07-31T08:00:00Z'),
          } as never;
        }
      })();
    },
    fetchOne: (async (seq: string) => ({
      source: Buffer.from(`RAW-${seq}-${randomUUID()}`),
    })) as never,
  };
  const session: MailboxSession = { client, uidValidity: 1, close: async () => undefined };
  return { session, requestedRanges };
}

function parsedLetter(): ParsedMail {
  return {
    subject: 'Документы',
    text: '',
    html: '',
    date: new Date('2026-07-31T08:00:00Z'),
    messageId: '<x@x>',
    from: { value: [{ address: 'snab@podryad.ru', name: '' }], html: '', text: '' },
    attachments: [
      {
        type: 'attachment',
        filename: 'upd.pdf',
        contentType: 'application/pdf',
        content: PDF,
        related: false,
        size: PDF.length,
      },
    ],
  } as unknown as ParsedMail;
}

suite('повторный забор письма (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const owner = randomUUID();

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
      INSERT INTO mail_accounts
        (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled, last_uid, uid_validity)
      VALUES ('replay', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true, 10, 1)
      RETURNING id`;
    accountId = acc!.id;
  });

  const account = async () => {
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
    return row!;
  };

  /** Письмо, сорвавшееся на скачивании и оставшееся НИЖЕ границы (last_uid = 10). */
  async function failedReceipt(uid: number, status = 'fetch_failed'): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail_receipts
        (mail_account_id, uid, uid_validity, status, attempts, last_error, rfc822_size)
      VALUES (${accountId}, ${uid}, 1, ${status}, 5, 'обрыв связи', 99999999)
      RETURNING id`;
    return row!.id;
  }

  const deps = (mailbox: ReturnType<typeof fakeMailbox>) => ({
    db,
    putObject: vi.fn().mockResolvedValue(undefined),
    copyObject: vi.fn().mockResolvedValue(undefined),
    parseMime: async () => parsedLetter(),
    openMailbox: async () => mailbox.session,
  });

  it('запрошенное письмо забирается, хотя граница его уже прошла', async () => {
    const receiptId = await failedReceipt(5);
    await requestReplay(db, receiptId);
    const mailbox = fakeMailbox([5, 11]);

    const res = await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(res.replayed).toBe(1);
    // Письмо принято в карантин — то есть дозабор дошёл до конца.
    const msgs = await sql<{ id: string }[]>`
      SELECT id FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const [receipt] = await sql<{ status: string; replay_requested_at: Date | null }[]>`
      SELECT status, replay_requested_at FROM mail_receipts WHERE id = ${receiptId}`;
    expect(receipt!.status).toBe('parsed');
    // Отметка снята — следующий проход письмо не потянет заново.
    expect(receipt!.replay_requested_at).toBeNull();
  });

  it('дозабор запрашивает конкретные UID, а не диапазон от границы', async () => {
    // Иначе перечитались бы все письма после проблемного.
    const receiptId = await failedReceipt(5);
    await requestReplay(db, receiptId);
    const mailbox = fakeMailbox([5, 11]);

    await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(mailbox.requestedRanges).toContain('5');
    // И обычный проход по-прежнему идёт от границы.
    expect(mailbox.requestedRanges.some((r) => r.startsWith('11:'))).toBe(true);
  });

  it('граница ящика от дозабора не сдвигается назад', async () => {
    const receiptId = await failedReceipt(5);
    await requestReplay(db, receiptId);
    const mailbox = fakeMailbox([5, 11]);

    const res = await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(res.watermarkBefore).toBe(10);
    // Письмо 11 обработано штатно, граница ушла вперёд, а не к пятёрке.
    expect(res.watermarkAfter).toBeGreaterThanOrEqual(11);
  });

  it('без запроса оператора старые письма не трогаются', async () => {
    await failedReceipt(5);
    const mailbox = fakeMailbox([5, 11]);

    const res = await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(res.replayed).toBe(0);
    expect(mailbox.requestedRanges).not.toContain('5');
  });

  it('пропущенное по размеру письмо забирается, когда лимит поднят', async () => {
    // Ровно тот случай, ради которого повтор и делался: письмо было больше
    // лимита, оператор его поднял и просит забрать.
    const receiptId = await failedReceipt(6, 'skipped_by_size');
    await requestReplay(db, receiptId);
    const mailbox = fakeMailbox([6, 11], { sizeByUid: { 6: 40 * 1024 * 1024 } });

    const res = await pollMailAccount(deps(mailbox), await account(), {
      owner,
      fetchLimits: { maxLetterBytes: 50 * 1024 * 1024, maxAttachmentBytes: 25 * 1024 * 1024 },
    });

    expect(res.replayed).toBe(1);
    const [receipt] = await sql<{ status: string }[]>`
      SELECT status FROM mail_receipts WHERE id = ${receiptId}`;
    expect(receipt!.status).toBe('parsed');
  });

  it('исчезнувшее из ящика письмо закрывается, а не повторяется вечно', async () => {
    const receiptId = await failedReceipt(7);
    await requestReplay(db, receiptId);
    // Письма 7 в ящике больше нет.
    const mailbox = fakeMailbox([11]);

    const res = await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(res.replayed).toBe(0);
    const [receipt] = await sql<{ status: string; replay_requested_at: Date | null }[]>`
      SELECT status, replay_requested_at FROM mail_receipts WHERE id = ${receiptId}`;
    expect(receipt!.status).toBe('vanished');
    expect(receipt!.replay_requested_at).toBeNull();
  });

  it('запись чужой нумерации не дозабирается', async () => {
    // UID из прежней нумерации указывает на другое письмо — дозабор притащил
    // бы не то.
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail_receipts (mail_account_id, uid, uid_validity, status, attempts, replay_requested_at)
      VALUES (${accountId}, 5, 99, 'fetch_failed', 5, now())
      RETURNING id`;
    const mailbox = fakeMailbox([5, 11]);

    const res = await pollMailAccount(deps(mailbox), await account(), { owner });

    expect(res.replayed).toBe(0);
    const [receipt] = await sql<{ replay_requested_at: Date | null }[]>`
      SELECT replay_requested_at FROM mail_receipts WHERE id = ${row!.id}`;
    // Отметка осталась: запись просто не относится к текущей нумерации.
    expect(receipt!.replay_requested_at).not.toBeNull();
  });
});
