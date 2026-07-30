/**
 * Приём заявок из почты на РЕАЛЬНОМ PostgreSQL.
 *
 * Зачем интеграционные: оба проверяемых дефекта живут в СУБД и на моках не
 * воспроизводятся.
 *   1. `ON CONFLICT` против частичного индекса `source_mail_message_unique` —
 *      без повторённого предиката PostgreSQL отвечает 42P10, и каждое письмо
 *      уходит в `failed`.
 *   2. Watermark `mail_accounts.last_uid` — сдвиг за упавшее письмо означает,
 *      что письмо уже никогда не попадёт в выборку `uid > last_uid`.
 *
 * IMAP и LLM замоканы: сеть и провайдер здесь ни при чём.
 *
 * Запуск:
 *   docker run -d --name matcheck-test-pg -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=matcheck_test \
 *     -p 5444:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx tsx scripts/migrate.ts
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test \
 *     npx vitest run test/integration
 *
 * Без TEST_DATABASE_URL набор пропускается — обычный `pnpm test` остаётся
 * зелёным на машине без поднятой БД.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchedMessage } from '../../src/domain/mail/imap.client.js';
import type { ParseOutput } from '../../src/domain/mail/request.parser.js';

const mocks = vi.hoisted(() => ({
  fetchNewMessages: vi.fn(),
  parseRequestFromMail: vi.fn(),
}));

vi.mock('../../src/domain/mail/imap.client.js', () => ({
  fetchNewMessages: mocks.fetchNewMessages,
}));
vi.mock('../../src/domain/mail/request.parser.js', () => ({
  parseRequestFromMail: mocks.parseRequestFromMail,
}));

const { runMailSyncForAccount } = await import('../../src/domain/jobs/mail-requests.js');
const { mailAccounts } = await import('../../src/db/schema.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Письмо с заданным UID; остальные поля для этих тестов безразличны. */
function message(uid: number, messageId: string): FetchedMessage {
  return {
    uid,
    messageId,
    subject: 'Заявка',
    receivedAt: new Date('2026-07-30T10:00:00Z'),
    textBody: 'нужны материалы',
    htmlBody: '',
    attachments: [],
  };
}

function parsed(docNumber: string): ParseOutput {
  return {
    data: {
      docNumber,
      items: [{ nameRaw: 'Цемент М500', qty: 10, unit: 'меш' }],
      confidence: 0.9,
    },
    providerId: 'test-provider',
    rawPrompt: '',
  };
}

suite('приём заявок из почты (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let accountId: string;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { max: 2 });
    const db = drizzle(sql);
    // Модулю нужны только db и log.warn.
    app = { db, log: { warn: () => {} } } as unknown as FastifyInstance;
  });

  afterAll(async () => {
    await sql`delete from source_documents where mail_account_id is not null`;
    await sql`delete from mail_accounts where host = 'imap.test.local'`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    mocks.fetchNewMessages.mockReset();
    mocks.parseRequestFromMail.mockReset();
    await sql`delete from source_documents where mail_account_id is not null`;
    await sql`delete from mail_accounts where host = 'imap.test.local'`;
    const [row] = await sql`
      insert into mail_accounts (name, host, port, use_tls, username, password_encrypted, folder)
      values ('test', 'imap.test.local', 993, true, 'u', 'not-a-real-secret', 'INBOX')
      returning id
    `;
    accountId = row.id as string;
  });

  /** Свежая строка аккаунта — в ней уже сдвинутый last_uid. */
  async function account() {
    const db = drizzle(sql);
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .limit(1);
    return row;
  }

  it('повторный прогон не создаёт дублей и не падает с 42P10', async () => {
    const letters = [message(10, '<a@example.org>')];
    mocks.fetchNewMessages.mockResolvedValue(letters);
    mocks.parseRequestFromMail.mockResolvedValue(parsed('R-1'));

    const first = await runMailSyncForAccount(app, await account());
    expect(first).toEqual({ imported: 1, failed: 0 });

    // Тот же ящик отдаёт то же письмо (например, watermark сброшен вручную или
    // письмо перечитано после переиндексации папки). Дедуп обязан сработать
    // молча: 42P10 дал бы failed = 1.
    const second = await runMailSyncForAccount(app, await account());
    expect(second).toEqual({ imported: 0, failed: 0 });

    const rows = await sql`
      select id from source_documents where mail_account_id = ${accountId}
    `;
    expect(rows).toHaveLength(1);
  });

  it('watermark не перешагивает упавшее письмо', async () => {
    // Порядок выдачи намеренно перемешан — модуль обязан отсортировать по UID.
    mocks.fetchNewMessages.mockResolvedValue([
      message(3, '<c@example.org>'),
      message(1, '<a@example.org>'),
      message(2, '<b@example.org>'),
    ]);
    mocks.parseRequestFromMail.mockImplementation(async (input: { emailBody: string }) => {
      void input;
      const call = mocks.parseRequestFromMail.mock.calls.length;
      // Второе по порядку UID письмо срывается.
      if (call === 2) throw new Error('LLM недоступен');
      return parsed(`R-${call}`);
    });

    const result = await runMailSyncForAccount(app, await account());
    expect(result).toEqual({ imported: 2, failed: 1 });

    // UID 1 обработан, UID 2 упал → watermark стоит на 1, хотя UID 3 успешен.
    // Иначе письмо 2 больше не вернётся никогда.
    const after = await account();
    expect(after.lastUid).toBe(1);
  });

  it('успешный прогон двигает watermark на максимальный UID', async () => {
    mocks.fetchNewMessages.mockResolvedValue([
      message(7, '<x@example.org>'),
      message(9, '<y@example.org>'),
    ]);
    mocks.parseRequestFromMail.mockResolvedValue(parsed('R-ok'));

    const result = await runMailSyncForAccount(app, await account());
    expect(result).toEqual({ imported: 2, failed: 0 });

    const after = await account();
    expect(after.lastUid).toBe(9);
  });
});
