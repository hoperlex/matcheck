import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { mailAccounts } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';

export type FetchedMessage = {
  uid: number;
  messageId: string | null;
  subject: string | null;
  receivedAt: Date;
  textBody: string;
  htmlBody: string;
  attachments: { filename: string; mimeType: string; buffer: Buffer }[];
};

export async function fetchNewMessages(
  account: typeof mailAccounts.$inferSelect,
  maxMessages = 50,
): Promise<FetchedMessage[]> {
  const password = decryptField(account.passwordEncrypted, buildAad('mail_accounts', account.id));
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.useTls,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  const results: FetchedMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(account.folder);
    try {
      const startUid = (account.lastUid ?? 0) + 1;
      const range = `${startUid}:*`;
      let processed = 0;
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        source: true,
        internalDate: true,
      })) {
        if (processed >= maxMessages) break;
        if (msg.uid <= (account.lastUid ?? 0)) continue;
        const source = msg.source as Buffer | undefined;
        if (!source) continue;
        const parsed = await simpleParser(source);
        results.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? msg.envelope?.messageId ?? null,
          subject: parsed.subject ?? msg.envelope?.subject ?? null,
          receivedAt: msg.internalDate instanceof Date ? msg.internalDate : new Date(),
          textBody: parsed.text ?? '',
          htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
          attachments: (parsed.attachments ?? []).map((att) => ({
            filename: att.filename ?? `attachment-${att.contentId ?? 'unknown'}`,
            mimeType: att.contentType ?? 'application/octet-stream',
            buffer: att.content,
          })),
        });
        processed += 1;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return results;
}
