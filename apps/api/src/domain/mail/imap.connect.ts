// Реальное подключение к почтовому ящику.
//
// Вынесено из imap.fetch.ts намеренно: там живут решения (что скачивать, в
// каком порядке), и они проверяются без сети. Здесь — только работа с
// библиотекой и расшифровка пароля, то есть то, что в тестах подменяется
// целиком.

import { ImapFlow } from 'imapflow';
import type { mailAccounts } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import type { ImapLike } from './imap.fetch.js';

export type MailboxSession = {
  client: ImapLike;
  /** Нумерация ящика: её смена обесценивает сохранённый watermark. */
  uidValidity: number;
  close: () => Promise<void>;
};

/**
 * Открывает папку ящика и возвращает сессию.
 *
 * Письма читаются через `BODY.PEEK` (так работает imapflow), поэтому флаг
 * «прочитано» не выставляется и владелец ящика видит почту нетронутой.
 * Ничего не удаляется и не перемещается.
 */
export async function openMailbox(
  account: typeof mailAccounts.$inferSelect,
): Promise<MailboxSession> {
  const password = decryptField(account.passwordEncrypted, buildAad('mail_accounts', account.id));
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.useTls,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  await client.connect();
  let lock: Awaited<ReturnType<typeof client.getMailboxLock>>;
  try {
    lock = await client.getMailboxLock(account.folder);
  } catch (err) {
    // Не оставляем висящее соединение, если папка недоступна.
    await client.logout().catch(() => undefined);
    throw err;
  }

  const mailbox = client.mailbox;
  if (!mailbox || typeof mailbox === 'boolean') {
    lock.release();
    await client.logout().catch(() => undefined);
    throw new Error(`IMAP: папка ${account.folder} не открылась`);
  }

  return {
    client: client as unknown as ImapLike,
    // UIDVALIDITY приходит bigint, но по RFC не превышает 2^32-1.
    uidValidity: Number(mailbox.uidValidity),
    close: async () => {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
}
