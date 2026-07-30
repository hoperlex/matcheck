/**
 * Обход почтовых ящиков.
 *
 * Главное проверяемое свойство: недоступный сервер одного подрядчика не должен
 * останавливать приём документов по остальным ящикам.
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
import { pollAccountById, pollAllAccounts } from '../../src/domain/jobs/mail-poll-runner.js';
import type { MailboxSession } from '../../src/domain/jobs/mail-poll.js';
import type { ImapLike } from '../../src/domain/mail/imap.fetch.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.runner.local';

/** Пустой ящик: метаданных нет, тела не запрашиваются. */
function emptyMailbox(): MailboxSession {
  const client: ImapLike = {
    fetch: () => (async function* () {})(),
    fetchOne: async () => false,
  };
  return { client, uidValidity: 1, close: async () => undefined };
}

const parsed = {} as unknown as ParsedMail;

suite('обход почтовых ящиков (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
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
  });

  async function addAccount(name: string, pollEnabled = true): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled)
      VALUES (${name}, ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', ${pollEnabled})
      RETURNING id`;
    return row!.id;
  }

  const baseDeps = (openMailbox: (a: unknown) => Promise<MailboxSession>) => ({
    db,
    putObject: vi.fn().mockResolvedValue(undefined),
    parseMime: async () => parsed,
    openMailbox: openMailbox as never,
  });

  /**
   * Идентификаторы ящиков ЭТОГО набора, к которым обращался обход.
   *
   * Считать общее число вызовов нельзя: тестовые файлы идут параллельно на одной
   * базе, и обход честно берёт все включённые ящики, включая чужие.
   */
  const touchedOurs = (openMailbox: { mock: { calls: unknown[][] } }): string[] =>
    openMailbox.mock.calls
      .map((c) => c[0] as { id: string; host: string })
      .filter((a) => a?.host === HOST)
      .map((a) => a.id);

  it('обходит только ящики с включённым опросом', async () => {
    await addAccount('включён', true);
    await addAccount('выключен', false);
    const openMailbox = vi.fn(async () => emptyMailbox());

    const enabled = (await sql<{ id: string }[]>`
      SELECT id FROM mail_accounts WHERE host = ${HOST} AND poll_enabled = true`)[0]!.id;

    await pollAllAccounts(baseDeps(openMailbox), { owner });

    expect(touchedOurs(openMailbox)).toEqual([enabled]);
  });

  it('падение одного ящика не мешает остальным', async () => {
    const broken = await addAccount('битый', true);
    await addAccount('рабочий', true);
    const onError = vi.fn();

    const openMailbox = vi.fn(async (account: { id: string }) => {
      if (account.id === broken) throw new Error('IMAP недоступен');
      return emptyMailbox();
    });

    await pollAllAccounts({ ...baseDeps(openMailbox as never), onError }, { owner });

    // Оба наших ящика опробованы, несмотря на падение первого.
    expect(touchedOurs(openMailbox as never)).toHaveLength(2);
    expect(onError.mock.calls.some((c) => c[1] === broken)).toBe(true);
    // Лиз упавшего ящика снят — следующий проход снова его попробует.
    const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, broken));
    expect(row!.pollLeaseToken).toBeNull();
  });

  it('пустой список ящиков — не ошибка', async () => {
    const openMailbox = vi.fn(async () => emptyMailbox());
    await pollAllAccounts(baseDeps(openMailbox), { owner });
    expect(touchedOurs(openMailbox)).toEqual([]);
  });

  it('занятый чужим лизом ящик учитывается как пропущенный', async () => {
    const id = await addAccount('занят', true);
    await db
      .update(mailAccounts)
      .set({
        pollLeaseOwner: randomUUID(),
        pollLeaseToken: randomUUID(),
        pollLeaseUntil: new Date(Date.now() + 10 * 60 * 1000),
      })
      .where(eq(mailAccounts.id, id));

    const openMailbox = vi.fn(async () => emptyMailbox());
    await pollAllAccounts(baseDeps(openMailbox), { owner });

    // Ящик занят чужим лизом — соединение не открывалось.
    expect(touchedOurs(openMailbox)).toEqual([]);
  });

  it('ручной запуск работает по идентификатору ящика', async () => {
    const id = await addAccount('ручной', true);
    const openMailbox = vi.fn(async () => emptyMailbox());

    const result = await pollAccountById(baseDeps(openMailbox), id, { owner });

    expect(result).toMatchObject({ fetched: 0, failed: 0 });
    expect(openMailbox).toHaveBeenCalledTimes(1);
  });

  it('ручной запуск по несуществующему ящику не падает', async () => {
    const openMailbox = vi.fn(async () => emptyMailbox());
    const result = await pollAccountById(baseDeps(openMailbox), randomUUID(), { owner });
    expect(result).toBeNull();
    expect(openMailbox).not.toHaveBeenCalled();
  });

  it('ручной запуск проверяет доступы даже при выключенном автоопросе', async () => {
    // Ровно этим администратор убеждается, что логин и пароль ящика верны,
    // ДО того как включит постоянный опрос.
    const id = await addAccount('выключен', false);
    const openMailbox = vi.fn(async () => emptyMailbox());

    const result = await pollAccountById(baseDeps(openMailbox), id, { owner, manual: true });

    expect(result?.skipped).toBeUndefined();
    expect(openMailbox).toHaveBeenCalledTimes(1);
  });

  it('автоматический обход выключенный ящик по-прежнему не трогает', async () => {
    await addAccount('выключен', false);
    const openMailbox = vi.fn(async () => emptyMailbox());

    await pollAllAccounts(baseDeps(openMailbox), { owner });

    expect(touchedOurs(openMailbox)).toEqual([]);
  });

  it('неактивный ящик не опрашивается даже вручную', async () => {
    const id = await addAccount('неактивен', true);
    await db.update(mailAccounts).set({ isActive: false }).where(eq(mailAccounts.id, id));
    const openMailbox = vi.fn(async () => emptyMailbox());

    const result = await pollAccountById(baseDeps(openMailbox), id, { owner, manual: true });

    expect(result?.skipped).toBe('lease_taken');
    expect(openMailbox).not.toHaveBeenCalled();
  });
});
