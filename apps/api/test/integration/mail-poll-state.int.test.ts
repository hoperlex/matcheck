/**
 * Состояние опроса ящика на РЕАЛЬНОМ PostgreSQL: лиз и журнал попыток.
 *
 * Оба механизма живут в SQL и на моках не воспроизводятся: захват лиза — это
 * условный `UPDATE ... WHERE лиз свободен` с `RETURNING`, а дедуп попыток —
 * `ON CONFLICT` по составному уникальному индексу. Время везде берётся из
 * `now()` базы, поэтому проверять его подменой часов процесса бессмысленно.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { mailAccounts } from '../../src/db/schema.js';
import {
  acquirePollLease,
  listPollableAccounts,
  releasePollLease,
  renewPollLease,
} from '../../src/domain/mail/poll-lease.js';
import {
  completeReceipt,
  failReceipt,
  loadReceiptsAfter,
  startReceipt,
} from '../../src/domain/mail/receipts.js';
import { computeWatermark, RECEIPT_MAX_ATTEMPTS } from '../../src/domain/mail/watermark.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.poll-state.local';

// Владелец лиза — uuid ЭКЗЕМПЛЯРА воркера (колонка poll_lease_owner типа uuid),
// а не человекочитаемое имя: по нему в логах видно, кто держит ящик.
const WORKER_1 = randomUUID();
const WORKER_2 = randomUUID();

suite('состояние опроса ящика (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;

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
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled)
      VALUES ('poll', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true)
      RETURNING id`;
    accountId = row!.id;
  });

  describe('лиз на опрос', () => {
    it('свободный ящик достаётся одному воркеру', async () => {
      const lease = await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 });
      expect(lease).not.toBeNull();
      expect(lease!.token).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('второй воркер не отбирает живой лиз', async () => {
      await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 });
      const second = await acquirePollLease(db, { accountId, owner: WORKER_2, ttlSeconds: 300 });
      expect(second).toBeNull();
    });

    it('истёкший лиз перехватывается — иначе упавший воркер запер бы ящик навсегда', async () => {
      const first = await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 });
      await db
        .update(mailAccounts)
        .set({ pollLeaseUntil: drSql`now() - interval '1 minute'` })
        .where(eq(mailAccounts.id, accountId));

      const second = await acquirePollLease(db, { accountId, owner: WORKER_2, ttlSeconds: 300 });
      expect(second).not.toBeNull();
      expect(second!.token).not.toBe(first!.token);
    });

    it('продлить можно только своим токеном', async () => {
      const lease = await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 });
      expect(await renewPollLease(db, lease!, 300)).toBe(true);

      const foreign = { ...lease!, token: randomUUID() };
      expect(await renewPollLease(db, foreign, 300)).toBe(false);
    });

    it('освободить можно только своим токеном', async () => {
      const lease = await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 });
      const foreign = { ...lease!, token: randomUUID() };

      // Перезапустившийся экземпляр не должен снимать лиз с того, кто прямо
      // сейчас качает письма.
      expect(await releasePollLease(db, foreign)).toBe(false);
      expect(await releasePollLease(db, lease!)).toBe(true);

      const next = await acquirePollLease(db, { accountId, owner: WORKER_2, ttlSeconds: 300 });
      expect(next).not.toBeNull();
    });

    it('выключенный опрос не захватывается', async () => {
      await db
        .update(mailAccounts)
        .set({ pollEnabled: false })
        .where(eq(mailAccounts.id, accountId));

      expect(await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 })).toBeNull();
      const pollable = await listPollableAccounts(db);
      expect(pollable.some((a) => a.id === accountId)).toBe(false);
    });

    it('неактивный ящик не захватывается', async () => {
      await db.update(mailAccounts).set({ isActive: false }).where(eq(mailAccounts.id, accountId));
      expect(await acquirePollLease(db, { accountId, owner: WORKER_1, ttlSeconds: 300 })).toBeNull();
    });
  });

  describe('журнал попыток забора', () => {
    it('повторный проход по тому же UID не создаёт дубля', async () => {
      const first = await startReceipt(db, { accountId, uidValidity: 1, uid: 10, rfc822Size: 500 });
      const again = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('fetching');
    });

    it('та же нумерация, другой UID — другая запись', async () => {
      const a = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      const b = await startReceipt(db, { accountId, uidValidity: 1, uid: 11 });
      expect(b.id).not.toBe(a.id);
    });

    it('смена UIDVALIDITY даёт независимую запись для того же UID', async () => {
      const old = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      const fresh = await startReceipt(db, { accountId, uidValidity: 2, uid: 10 });
      expect(fresh.id).not.toBe(old.id);
    });

    it('ошибка увеличивает счётчик попыток и сохраняет причину', async () => {
      const receipt = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      await failReceipt(db, receipt.id, 'fetch_failed', new Error('соединение разорвано'));
      await failReceipt(db, receipt.id, 'fetch_failed', new Error('соединение разорвано'));

      const [state] = await loadReceiptsAfter(db, { accountId, uidValidity: 1, afterUid: 0 });
      expect(state).toMatchObject({ uid: 10, status: 'fetch_failed', attempts: 2 });
    });

    it('успех фиксирует ключ сырого письма и снимает ошибку', async () => {
      const receipt = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      await failReceipt(db, receipt.id, 'fetch_failed', new Error('таймаут'));
      await completeReceipt(db, receipt.id, 'parsed', 'mail/raw/10.eml');

      const [row] = await sql<{ status: string; raw_s3_key: string; last_error: string | null }[]>`
        SELECT status, raw_s3_key, last_error FROM mail_receipts WHERE id = ${receipt.id}`;
      expect(row).toMatchObject({ status: 'parsed', raw_s3_key: 'mail/raw/10.eml', last_error: null });
    });
  });

  describe('журнал и граница вместе', () => {
    it('упавшее письмо не даёт границе перешагнуть себя', async () => {
      const failed = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      await failReceipt(db, failed.id, 'fetch_failed', new Error('обрыв'));
      const ok = await startReceipt(db, { accountId, uidValidity: 1, uid: 11 });
      await completeReceipt(db, ok.id, 'parsed');

      const states = await loadReceiptsAfter(db, { accountId, uidValidity: 1, afterUid: 9 });
      expect(computeWatermark(9, states)).toBe(9);
    });

    it('после исчерпания попыток граница проходит дальше', async () => {
      const failed = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
      for (let i = 0; i < RECEIPT_MAX_ATTEMPTS; i++) {
        await failReceipt(db, failed.id, 'fetch_failed', new Error('обрыв'));
      }
      const ok = await startReceipt(db, { accountId, uidValidity: 1, uid: 11 });
      await completeReceipt(db, ok.id, 'parsed');

      const states = await loadReceiptsAfter(db, { accountId, uidValidity: 1, afterUid: 9 });
      expect(computeWatermark(9, states)).toBe(11);
    });

    it('успешная серия двигает границу до последнего письма', async () => {
      for (const uid of [10, 11, 12]) {
        const receipt = await startReceipt(db, { accountId, uidValidity: 1, uid });
        await completeReceipt(db, receipt.id, 'parsed');
      }
      const states = await loadReceiptsAfter(db, { accountId, uidValidity: 1, afterUid: 9 });
      expect(computeWatermark(9, states)).toBe(12);
    });
  });
});
