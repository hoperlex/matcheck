// Обработка одного письма: от сырого .eml до записи в карантине.
//
// Порядок шагов выбран так, чтобы сбой на любом из них не оставлял мусора и не
// терял письмо:
//
//   1. дедуп по хешу СЫРОГО письма — до заливки файлов, иначе повтор копил бы
//      объекты в S3;
//   2. заливка raw и вложений по ДЕТЕРМИНИРОВАННЫМ ключам — повтор
//      перезаписывает те же объекты, дубликатов не появляется;
//   3. запись в БД одной транзакцией — если S3 упал, в базе не остаётся
//      письма без вложений, и повтор проходит начисто.
//
// Пакет документов здесь НЕ создаётся: письмо доводится до карантина с
// решением матчера объекта. Создание пакета — отдельный шаг.

import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ParsedMail } from 'mailparser';
import type { Db } from '../../db/client.js';
import { mailAttachments, mailMessages } from '../../db/schema.js';
import { matchSite, type SiteMatch, type SiteRef } from '../sourceDocuments/siteHint.js';
import {
  classifyAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
} from './attachment-filter.js';
import { parseDeliveryDateHint } from './letter-hints.js';

export type PutObject = (key: string, body: Buffer, contentType: string) => Promise<void>;

export type IngestDeps = {
  db: Db;
  putObject: PutObject;
  /** Разбор MIME. Подменяется в тестах, чтобы не собирать письма руками. */
  parseMime: (raw: Buffer) => Promise<ParsedMail>;
  log?: { warn: (o: unknown, m?: string) => void };
};

export type IngestParams = {
  accountId: string;
  uidValidity: number;
  uid: number;
  receiptId: string;
  raw: Buffer;
  /** Справочник объектов для матчера. */
  sites: readonly SiteRef[];
  limits?: AttachmentLimits;
};

export type IngestOutcome =
  /** Такое письмо уже разбирали — файлы не перезаливались, строка не создавалась. */
  | { outcome: 'duplicate'; messageId: string }
  | {
      outcome: 'stored';
      messageId: string;
      status: 'quarantined' | 'no_attachments';
      keptAttachments: number;
      rawS3Key: string;
      match: SiteMatch;
      expectedDate: string | null;
    };

/** Имя файла для ключа: без разделителей пути и разумной длины. */
function safeName(filename: string | null | undefined, idx: number): string {
  const base = (filename ?? '').replace(/[/\\]/g, '_').trim().slice(-100);
  return base || `attachment-${idx + 1}.bin`;
}

/**
 * Ключи staging детерминированы по (ящик, нумерация, uid): повторная обработка
 * пишет в те же объекты, поэтому сбой между S3 и БД не плодит осиротевшие
 * файлы.
 */
export function buildMailRawKey(p: { accountId: string; uidValidity: number; uid: number }): string {
  return `mail/${p.accountId}/${p.uidValidity}/${p.uid}/raw.eml`;
}

export function buildMailAttachmentKey(
  p: { accountId: string; uidValidity: number; uid: number },
  idx: number,
  filename: string | null | undefined,
): string {
  return `mail/${p.accountId}/${p.uidValidity}/${p.uid}/att-${idx + 1}-${safeName(filename, idx)}`;
}

/** Ссылается ли html-часть письма на этот cid — признак картинки вёрстки. */
function isCidReferenced(html: string, cid: string | undefined): boolean {
  if (!cid) return false;
  return html.includes(cid);
}

export async function ingestLetter(
  deps: IngestDeps,
  params: IngestParams,
): Promise<IngestOutcome> {
  const { db, putObject, parseMime } = deps;
  const limits = params.limits ?? DEFAULT_ATTACHMENT_LIMITS;

  // Хеш от ПОЛНОГО сырого письма, а не от Message-ID: заголовок подделывается,
  // и злоумышленник мог бы выдать свой конверт за уже обработанный, добившись
  // молчаливого отбрасывания настоящего УПД.
  const messageHash = createHash('sha256').update(params.raw).digest('hex');

  const [duplicate] = await db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.mailAccountId, params.accountId),
        eq(mailMessages.messageHash, messageHash),
      ),
    )
    .limit(1);
  if (duplicate) return { outcome: 'duplicate', messageId: duplicate.id };

  const parsed = await parseMime(params.raw);
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = parsed.text ?? '';

  // Решения по вложениям принимаются до записи в БД, чтобы одна транзакция
  // сохранила согласованную картину.
  const attachments = parsed.attachments ?? [];
  const decided = attachments.map((att, idx) => {
    const verdict = classifyAttachment(
      {
        filename: att.filename ?? null,
        declaredMime: att.contentType ?? null,
        buffer: att.content,
        isRelated: att.related === true,
        cidReferenced: isCidReferenced(html, att.cid),
      },
      limits,
    );
    return { att, idx, verdict };
  });

  const rawKey = buildMailRawKey(params);
  // Сырое письмо сохраняем всегда: без него невозможно восстановить обработку
  // после смены нумерации ящика или ошибки разбора.
  await putObject(rawKey, params.raw, 'message/rfc822');

  const stagingKeys = new Map<number, string>();
  for (const { att, idx, verdict } of decided) {
    // Отброшенное в S3 не льём: причина сохраняется в БД, а поверхность
    // хранения не растёт от мусорных писем.
    if (verdict.state === 'skipped') continue;
    const key = buildMailAttachmentKey(params, idx, att.filename);
    await putObject(key, att.content, verdict.sniffedMime ?? 'application/octet-stream');
    stagingKeys.set(idx, key);
  }

  const filenames = decided
    .filter((d) => d.verdict.state !== 'skipped')
    .map((d) => d.att.filename ?? '')
    .filter(Boolean);
  const match = matchSite({ subject: parsed.subject ?? null, body: text, filenames }, params.sites);
  const expectedDate = parseDeliveryDateHint(`${parsed.subject ?? ''}\n${text}`);

  const keptAttachments = decided.filter((d) => d.verdict.state === 'kept').length;
  // Письмо без единого пригодного вложения в разбор не попадает: иначе список
  // оператора зарастёт перепиской и рассылками.
  const status = keptAttachments > 0 ? 'quarantined' : 'no_attachments';
  const suggestedSiteId =
    match.decision === 'explicit'
      ? match.siteId
      : match.suggestions.length === 1
        ? match.suggestions[0]!.siteId
        : null;

  const messageId = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(mailMessages)
      .values({
        mailAccountId: params.accountId,
        receiptId: params.receiptId,
        messageHash,
        messageIdHeader: parsed.messageId ?? null,
        fromAddress: parsed.from?.value?.[0]?.address ?? null,
        subject: parsed.subject ?? null,
        receivedAt: parsed.date ?? null,
        status,
        suggestedSiteId,
        rawS3Key: rawKey,
      })
      // Страховка на случай гонки: ящик держит один воркер по лизу, но полагаться
      // только на это нельзя.
      .onConflictDoNothing({
        target: [mailMessages.mailAccountId, mailMessages.messageHash],
      })
      .returning({ id: mailMessages.id });
    if (!inserted) return null;

    if (decided.length > 0) {
      await tx.insert(mailAttachments).values(
        decided.map(({ att, idx, verdict }) => ({
          mailMessageId: inserted.id,
          idx,
          filename: att.filename ?? null,
          declaredMime: att.contentType ?? null,
          sniffedMime: verdict.sniffedMime,
          sizeBytes: att.content.length,
          sha256: createHash('sha256').update(att.content).digest('hex'),
          stagingS3Key: stagingKeys.get(idx) ?? null,
          state: verdict.state,
          skipReason: verdict.reason ?? null,
        })),
      );
    }
    return inserted.id;
  });

  if (!messageId) {
    const [existing] = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.mailAccountId, params.accountId),
          eq(mailMessages.messageHash, messageHash),
        ),
      )
      .limit(1);
    return { outcome: 'duplicate', messageId: existing?.id ?? '' };
  }

  return {
    outcome: 'stored',
    messageId,
    status,
    keptAttachments,
    rawS3Key: rawKey,
    match,
    expectedDate,
  };
}
