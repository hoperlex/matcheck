/**
 * Сквозной путь: письмо в ящике → документ, готовый к распознаванию.
 *
 * Ради этого и делалась вся цепочка. Проверяется главное обещание: письмо с
 * явно указанным объектом проходит БЕЗ участия менеджера, а всё сомнительное
 * остаётся в разборе и документов не создаёт.
 *
 * IMAP, MIME и S3 подменены; база — настоящая.
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

const HOST = 'imap.auto-resolve.local';
const PDF = Buffer.from('%PDF-1.4\nупд\n%%EOF\n');

/** Ящик с одним письмом; тело возвращается по запросу второй фазы. */
function mailboxWith(uids: number[], uidValidity = 1): MailboxSession {
  const client: ImapLike = {
    fetch: (range) => {
      const from = Number(range.split(':')[0]);
      return (async function* () {
        for (const uid of uids) {
          if (uid < from) continue;
          yield {
            uid,
            size: 2000,
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
    fetchOne: (async (seq: string) => ({ source: Buffer.from(`RAW-${seq}-${randomUUID()}`) })) as never,
  };
  return { client, uidValidity, close: async () => undefined };
}

function letterWith(subject: string, text = ''): ParsedMail {
  return {
    subject,
    text,
    html: '',
    date: new Date('2026-07-31T08:00:00Z'),
    messageId: `<${subject}@x>`,
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

suite('письмо → документ без участия менеджера (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  let putObject: ReturnType<typeof vi.fn>;
  let copyObject: ReturnType<typeof vi.fn>;
  const owner = randomUUID();

  const siteId = randomUUID();
  let siteCode: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    siteCode = `AUTO${Date.now() % 10000}`;
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${siteCode}, 'Автоприём')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    const [acc] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled)
      VALUES ('auto', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true)
      RETURNING id`;
    accountId = acc!.id;
    putObject = vi.fn().mockResolvedValue(undefined);
    copyObject = vi.fn().mockResolvedValue(undefined);
  });

  const account = async () => {
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
    return row!;
  };

  it('письмо с «Объект: КОД» само становится документом', async () => {
    const acc = await account();
    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith(`Объект: ${siteCode}`),
        openMailbox: async () => mailboxWith([1]),
      },
      acc,
      { owner },
    );

    expect(result).toMatchObject({ fetched: 1, stored: 1, autoResolved: 1, quarantined: 0 });

    // Пакет создан на нужном объекте и готов к разбору.
    const [bundle] = await sql<{ status: string; origin: string }[]>`
      SELECT status, origin FROM source_bundles WHERE site_id = ${siteId}`;
    expect(bundle).toMatchObject({ status: 'queued', origin: 'mail' });

    // Задание на распознавание лежит в outbox. Ищем по ключу СВОЕГО пакета:
    // таблица общая, и параллельные наборы чистят её под себя.
    const [bundleRow] = await sql<{ id: string }[]>`
      SELECT id FROM source_bundles WHERE site_id = ${siteId}`;
    const jobs = await sql`
      SELECT id FROM job_outbox WHERE dedupe_key = ${`bundle:${bundleRow!.id}:parse:0`}`;
    expect(jobs).toHaveLength(1);

    // Письмо принято, менеджер не потребовался.
    const [msg] = await sql<{ status: string }[]>`
      SELECT status FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(msg!.status).toBe('ingested');
    expect(copyObject).toHaveBeenCalledTimes(1);
  });

  it('письмо без указания объекта ждёт в разборе', async () => {
    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith('Документы по поставке'),
        openMailbox: async () => mailboxWith([1]),
      },
      await account(),
      { owner },
    );

    expect(result).toMatchObject({ stored: 1, autoResolved: 0, quarantined: 1 });
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteId}`).toHaveLength(0);
    const [msg] = await sql<{ status: string }[]>`
      SELECT status FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(msg!.status).toBe('quarantined');
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('голый код объекта в теме — только подсказка, автопрохода нет', async () => {
    // Ключевое правило: подсказка (код без слова «Объект», название, имя файла)
    // объект НЕ подтверждает. Иначе слово из адреса или старой переписки
    // отправило бы настоящий УПД на чужую площадку.
    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith(`УПД ${siteCode} за июль`),
        openMailbox: async () => mailboxWith([1]),
      },
      await account(),
      { owner },
    );

    expect(result).toMatchObject({ stored: 1, autoResolved: 0, quarantined: 1 });
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteId}`).toHaveLength(0);
    expect(copyObject).not.toHaveBeenCalled();

    // Подсказка при этом сохранена — оператор увидит предложенный объект.
    const [msg] = await sql<{ status: string; suggested_site_id: string | null }[]>`
      SELECT status, suggested_site_id FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(msg).toMatchObject({ status: 'quarantined', suggested_site_id: siteId });
  });

  it('неизвестный код объекта в разбор, а не «наугад»', async () => {
    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith('Объект: НЕТТАКОГО'),
        openMailbox: async () => mailboxWith([1]),
      },
      await account(),
      { owner },
    );

    expect(result).toMatchObject({ autoResolved: 0, quarantined: 1 });
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteId}`).toHaveLength(0);
  });

  it('сбой копирования файлов не теряет письмо и не роняет проход', async () => {
    copyObject.mockRejectedValue(new Error('S3 недоступен'));

    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith(`Объект: ${siteCode}`),
        openMailbox: async () => mailboxWith([1]),
      },
      await account(),
      { owner },
    );

    // Транспорт отработал: письмо забрано, граница сдвинулась.
    expect(result).toMatchObject({ stored: 1, autoResolved: 0, quarantined: 1, failed: 0 });
    expect(result.watermarkAfter).toBe(1);
    // Документов нет, письмо ждёт оператора.
    expect(await sql`SELECT id FROM source_documents WHERE site_id = ${siteId}`).toHaveLength(0);
  });

  it('автопроход можно выключить — тогда всё уходит в разбор', async () => {
    const result = await pollMailAccount(
      {
        db,
        putObject,
        copyObject,
        parseMime: async () => letterWith(`Объект: ${siteCode}`),
        openMailbox: async () => mailboxWith([1]),
      },
      await account(),
      { owner, autoResolve: false },
    );

    expect(result).toMatchObject({ stored: 1, autoResolved: 0 });
    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteId}`).toHaveLength(0);
    expect(copyObject).not.toHaveBeenCalled();
  });

  it('повторный проход по тому же письму второй пакет не создаёт', async () => {
    const deps = {
      db,
      putObject,
      copyObject,
      parseMime: async () => letterWith(`Объект: ${siteCode}`),
      openMailbox: async () => mailboxWith([1]),
    };
    await pollMailAccount(deps, await account(), { owner });
    // Сбрасываем границу, как будто ящик перечитывают заново.
    await db.update(mailAccounts).set({ lastUid: 0 }).where(eq(mailAccounts.id, accountId));

    await pollMailAccount(deps, await account(), { owner });

    expect(await sql`SELECT id FROM source_bundles WHERE site_id = ${siteId}`).toHaveLength(1);
  });
});
