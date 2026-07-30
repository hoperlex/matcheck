/**
 * Цикл опроса ящика целиком: реальный PostgreSQL, подменённые IMAP и S3.
 *
 * Проверяется поведение прохода как единого целого — то, что нельзя увидеть на
 * отдельных модулях: где останавливается граница при сбое, освобождается ли
 * лиз после падения, что происходит при смене нумерации ящика.
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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.poll-cycle.local';
const PDF = Buffer.from('%PDF-1.4\nupd\n%%EOF\n');

type FakeLetter = {
  uid: number;
  size?: number;
  raw?: Buffer | null;
  subject?: string;
  withAttachment?: boolean;
};

/** IMAP-сервер из списка писем: первая фаза отдаёт метаданные, вторая — тело. */
function fakeMailbox(letters: FakeLetter[], uidValidity = 1) {
  const fetchOne = vi.fn(async (seq: string) => {
    const letter = letters.find((l) => String(l.uid) === seq);
    if (!letter || letter.raw === null) return false;
    return { source: letter.raw ?? Buffer.from(`RAW-${letter.uid}`) };
  });

  const client: ImapLike = {
    fetch: (range) => {
      const from = Number(range.split(':')[0]);
      return (async function* () {
        for (const l of letters) {
          if (l.uid < from) continue;
          yield {
            uid: l.uid,
            size: l.size ?? 1000,
            envelope: { messageId: `<${l.uid}@x>`, subject: l.subject ?? 'УПД' },
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { type: 'text/plain', size: 100 },
                ...(l.withAttachment === false
                  ? []
                  : [{ type: 'application/pdf', size: 5000, disposition: 'attachment' }]),
              ],
            },
            internalDate: new Date('2026-07-30T10:00:00Z'),
          } as never;
        }
      })();
    },
    fetchOne: fetchOne as unknown as ImapLike['fetchOne'],
  };

  const close = vi.fn(async () => undefined);
  const session: MailboxSession = { client, uidValidity, close };
  return { session, close, fetchOne };
}

function parsedMail(subject: string, withAttachment = true): ParsedMail {
  return {
    subject,
    text: 'Направляю документы',
    html: '',
    date: new Date('2026-07-30T09:00:00Z'),
    messageId: `<${subject}@x>`,
    from: { value: [{ address: 'snab@podryad.ru', name: '' }], html: '', text: '' },
    attachments: withAttachment
      ? [
          {
            type: 'attachment',
            filename: 'upd.pdf',
            contentType: 'application/pdf',
            content: PDF,
            related: false,
            size: PDF.length,
          },
        ]
      : [],
  } as unknown as ParsedMail;
}

suite('цикл опроса ящика (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  let putObject: ReturnType<typeof vi.fn>;
  const owner = randomUUID();

  beforeAll(() => {
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
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled)
      VALUES ('poll', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true)
      RETURNING id`;
    accountId = acc!.id;
    putObject = vi.fn().mockResolvedValue(undefined);
  });

  const account = async () => {
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
    return row!;
  };

  it('успешный проход: письма приняты, граница на последнем UID', async () => {
    const mailbox = fakeMailbox([{ uid: 1 }, { uid: 2 }, { uid: 3 }]);
    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a'), openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    expect(result).toMatchObject({ fetched: 3, failed: 0, watermarkAfter: 3 });
    expect((await account()).lastUid).toBe(3);
    // Соединение закрыто, лиз снят.
    expect(mailbox.close).toHaveBeenCalled();
    expect((await account()).pollLeaseToken).toBeNull();
  });

  it('сбой на письме останавливает границу на предыдущем UID', async () => {
    const mailbox = fakeMailbox([{ uid: 1 }, { uid: 2 }, { uid: 3 }]);
    let call = 0;
    const parse = async () => {
      call += 1;
      // Второе письмо не разбирается.
      if (call === 2) throw new Error('MIME сломан');
      return parsedMail(`письмо-${call}`);
    };

    const result = await pollMailAccount(
      { db, putObject, parseMime: parse, openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    expect(result.failed).toBe(1);
    // Третье письмо обработано, но граница осталась на первом — иначе второе
    // не вернулось бы в выборку никогда.
    expect(result.watermarkAfter).toBe(1);
    expect((await account()).lastUid).toBe(1);

    const rows = await sql<{ uid: number; status: string; attempts: number }[]>`
      SELECT uid, status, attempts FROM mail_receipts
      WHERE mail_account_id = ${accountId} ORDER BY uid`;
    expect(rows.map((r) => r.status)).toEqual(['parsed', 'fetch_failed', 'parsed']);
  });

  it('слишком большое письмо пропускается без скачивания', async () => {
    const mailbox = fakeMailbox([{ uid: 1, size: 400 * 1024 * 1024 }, { uid: 2 }]);
    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a'), openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    // Тело первого письма не запрашивалось.
    expect(mailbox.fetchOne).toHaveBeenCalledTimes(1);
    expect(mailbox.fetchOne).toHaveBeenCalledWith('2', expect.anything(), expect.anything());
    // Пропуск по размеру терминален, поэтому граница идёт дальше.
    expect(result.watermarkAfter).toBe(2);

    const [first] = await sql<{ status: string }[]>`
      SELECT status FROM mail_receipts WHERE mail_account_id = ${accountId} AND uid = 1`;
    expect(first!.status).toBe('skipped_by_size');
  });

  it('письмо без вложений не скачивается и в разбор не идёт', async () => {
    const mailbox = fakeMailbox([{ uid: 1, withAttachment: false }]);
    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a', false), openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    expect(mailbox.fetchOne).not.toHaveBeenCalled();
    expect(result.watermarkAfter).toBe(1);
    const messages = await sql`SELECT id FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(messages).toHaveLength(0);
  });

  it('исчезнувшее между фазами письмо помечается и не ломает проход', async () => {
    const mailbox = fakeMailbox([{ uid: 1, raw: null }, { uid: 2 }]);
    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a'), openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    expect(result.failed).toBe(0);
    expect(result.watermarkAfter).toBe(2);
    const [first] = await sql<{ status: string }[]>`
      SELECT status FROM mail_receipts WHERE mail_account_id = ${accountId} AND uid = 1`;
    expect(first!.status).toBe('vanished');
  });

  it('повторный проход не обрабатывает письма заново', async () => {
    const mailbox = fakeMailbox([{ uid: 1 }, { uid: 2 }]);
    const deps = {
      db,
      putObject,
      parseMime: async (raw: Buffer) => parsedMail(raw.toString()),
      openMailbox: async () => mailbox.session,
    };
    await pollMailAccount(deps, await account(), { owner });
    putObject.mockClear();

    const second = await pollMailAccount(deps, await account(), { owner });
    expect(second.fetched).toBe(0);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('смена нумерации ящика сбрасывает границу', async () => {
    const first = fakeMailbox([{ uid: 1 }, { uid: 2 }], 100);
    await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a'), openMailbox: async () => first.session },
      await account(),
      { owner },
    );
    expect((await account()).lastUid).toBe(2);

    // Сервер перенумеровал ящик: прежние UID недействительны.
    const renumbered = fakeMailbox([{ uid: 1 }, { uid: 2 }], 200);
    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('b'), openMailbox: async () => renumbered.session },
      await account(),
      { owner },
    );

    expect(result.uidValidityReset).toBe(true);
    expect(result.watermarkBefore).toBe(0);
    expect(result.fetched).toBe(2);
    expect((await account()).uidValidity).toBe(200);
  });

  it('занятый ящик пропускается без обработки', async () => {
    const mailbox = fakeMailbox([{ uid: 1 }]);
    await db
      .update(mailAccounts)
      .set({
        pollLeaseOwner: randomUUID(),
        pollLeaseToken: randomUUID(),
        pollLeaseUntil: new Date(Date.now() + 10 * 60 * 1000),
      })
      .where(eq(mailAccounts.id, accountId));

    const result = await pollMailAccount(
      { db, putObject, parseMime: async () => parsedMail('a'), openMailbox: async () => mailbox.session },
      await account(),
      { owner },
    );

    expect(result.skipped).toBe('lease_taken');
    expect(mailbox.close).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });

  it('падение подключения освобождает лиз', async () => {
    await expect(
      pollMailAccount(
        {
          db,
          putObject,
          parseMime: async () => parsedMail('a'),
          openMailbox: async () => {
            throw new Error('IMAP недоступен');
          },
        },
        await account(),
        { owner },
      ),
    ).rejects.toThrow('IMAP недоступен');

    // Иначе ящик был бы заперт до истечения TTL.
    expect((await account()).pollLeaseToken).toBeNull();
  });
});
