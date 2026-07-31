/**
 * Обработка письма до карантина: реальный PostgreSQL, подменённые S3 и MIME.
 *
 * Проверяется то, ради чего порядок шагов и выбран: повтор письма не перезаливает
 * файлы, сбой не оставляет письмо без вложений, отброшенное в хранилище не
 * попадает, а решение об объекте принимается по правилам матчера.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { ParsedMail } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ingestLetter, buildMailRawKey } from '../../src/domain/mail/ingest-message.js';
import { startReceipt } from '../../src/domain/mail/receipts.js';
import type { SiteRef } from '../../src/domain/sourceDocuments/siteHint.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const HOST = 'imap.ingest.local';
const PDF = Buffer.from('%PDF-1.4\nfake upd\n%%EOF\n');
const PNG_SMALL = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4096, 0x22),
]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(1024)]);

/** Минимальный ParsedMail: собирать настоящие MIME-конверты здесь незачем. */
function mail(over: Partial<ParsedMail> & { attachments?: unknown[] } = {}): ParsedMail {
  return {
    subject: 'УПД',
    text: '',
    html: '',
    date: new Date('2026-07-30T09:00:00Z'),
    messageId: '<letter@example.org>',
    from: { value: [{ address: 'snab@podryad.ru', name: '' }], html: '', text: '' },
    attachments: [],
    ...over,
  } as unknown as ParsedMail;
}

function attachment(over: {
  filename?: string;
  contentType?: string;
  content: Buffer;
  related?: boolean;
  cid?: string;
}) {
  return {
    type: 'attachment',
    filename: over.filename ?? 'upd.pdf',
    contentType: over.contentType ?? 'application/pdf',
    content: over.content,
    related: over.related ?? false,
    cid: over.cid,
    size: over.content.length,
  };
}

suite('приём письма в карантин (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  let receiptId: string;
  let putObject: ReturnType<typeof vi.fn>;
  let sites: SiteRef[];

  let zil33: string;
  let al13: string;
  /** Убираем за собой только те объекты, которые сами и завели. */
  const createdSites: string[] = [];

  /**
   * Коды объектов уникальны в справочнике, а тестовая база может быть засеяна
   * реальными: берём существующий объект, если он есть, и создаём только при
   * необходимости.
   */
  async function ensureSite(code: string, name: string): Promise<string> {
    const [found] = await sql<{ id: string }[]>`SELECT id FROM sites WHERE code = ${code} LIMIT 1`;
    if (found) return found.id;
    const id = randomUUID();
    await sql`INSERT INTO sites (id, code, name) VALUES (${id}, ${code}, ${name})`;
    createdSites.push(id);
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
    zil33 = await ensureSite('ЗИЛ33', 'ЖК МАРК (ЛОТ №33)');
    al13 = await ensureSite('АЛ13', 'ЖК АЛИЯ, БЛОКИ 13А, 13B');
    sites = [
      { id: zil33, code: 'ЗИЛ33', name: 'ЖК МАРК (ЛОТ №33)', isActive: true },
      { id: al13, code: 'АЛ13', name: 'ЖК АЛИЯ, БЛОКИ 13А, 13B', isActive: true },
    ];
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    if (createdSites.length > 0) {
      await sql`DELETE FROM sites WHERE id = ANY(${createdSites})`;
    }
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM mail_accounts WHERE host = ${HOST}`;
    const [acc] = await sql<{ id: string }[]>`
      INSERT INTO mail_accounts (name, host, port, use_tls, username, password_encrypted, folder, purpose, poll_enabled)
      VALUES ('ingest', ${HOST}, 993, true, 'u', 'not-a-real-secret', 'INBOX', 'document', true)
      RETURNING id`;
    accountId = acc!.id;
    const receipt = await startReceipt(db, { accountId, uidValidity: 1, uid: 10 });
    receiptId = receipt.id;
    putObject = vi.fn().mockResolvedValue(undefined);
  });

  const run = (parsed: ParsedMail, raw = Buffer.from(`RAW-${randomUUID()}`), uid = 10) =>
    ingestLetter(
      { db, putObject, parseMime: async () => parsed },
      { accountId, uidValidity: 1, uid, receiptId, raw, sites },
    );

  it('письмо с УПД и явным объектом уходит в карантин с решением матчера', async () => {
    const parsed = mail({
      subject: 'Объект: ЗИЛ33',
      text: 'Направляю УПД',
      attachments: [attachment({ content: PDF })],
    });
    const result = await run(parsed);

    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.status).toBe('quarantined');
    expect(result.keptAttachments).toBe(1);
    expect(result.match).toMatchObject({ decision: 'explicit', code: 'ЗИЛ33' });

    const [row] = await sql<{ status: string; suggested_site_id: string; raw_s3_key: string }[]>`
      SELECT status, suggested_site_id, raw_s3_key FROM mail_messages WHERE id = ${result.messageId}`;
    expect(row).toMatchObject({ status: 'quarantined', suggested_site_id: zil33 });
    expect(row!.raw_s3_key).toBe(buildMailRawKey({ accountId, uidValidity: 1, uid: 10 }));

    const atts = await sql<{ state: string; staging_s3_key: string }[]>`
      SELECT state, staging_s3_key FROM mail_attachments WHERE mail_message_id = ${result.messageId}`;
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({ state: 'kept' });
    // Сырое письмо + вложение.
    expect(putObject).toHaveBeenCalledTimes(2);
  });

  it('повтор того же письма не создаёт запись и не перезаливает файлы', async () => {
    const parsed = mail({ subject: 'Объект: ЗИЛ33', attachments: [attachment({ content: PDF })] });
    const raw = Buffer.from('RAW-IDENTICAL');
    const first = await run(parsed, raw);
    putObject.mockClear();

    const second = await run(parsed, raw);
    expect(second.outcome).toBe('duplicate');
    if (second.outcome === 'duplicate') expect(second.messageId).toBe(first.messageId);
    // Дедуп срабатывает ДО заливки — иначе повторы копили бы объекты в S3.
    expect(putObject).not.toHaveBeenCalled();

    const rows = await sql`SELECT id FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(rows).toHaveLength(1);
  });

  it('письмо без вложений не попадает в разбор', async () => {
    const result = await run(mail({ subject: 'Вопрос по оплате', text: 'Добрый день' }));
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.status).toBe('no_attachments');
    expect(result.keptAttachments).toBe(0);
  });

  it('картинка подписи помечается, но сохраняется рядом с документом', async () => {
    // Конверт как на реальной почте: иконка лежит обычным вложением, без
    // Content-ID и без html-части. Прежний фильтр требовал признаков
    // multipart/related и на таком письме не срабатывал.
    const parsed = mail({
      subject: 'Объект: ЗИЛ33',
      attachments: [
        attachment({ content: PDF }),
        attachment({
          filename: 'image001.png',
          contentType: 'image/png',
          content: PNG_SMALL,
        }),
      ],
    });
    const result = await run(parsed);
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.keptAttachments).toBe(1);

    const atts = await sql<{ state: string; staging_s3_key: string | null }[]>`
      SELECT state, staging_s3_key FROM mail_attachments
      WHERE mail_message_id = ${result.messageId} ORDER BY idx`;
    expect(atts.map((a) => a.state)).toEqual(['kept', 'suspected_signature']);
    // Подозрительное тоже лежит в хранилище: оператор возвращает его одним
    // действием, ничего не потеряно.
    expect(atts[1]!.staging_s3_key).not.toBeNull();
  });

  it('письмо только из картинок подписи остаётся в разборе', async () => {
    // Иначе оно получило бы no_attachments: этот статус не показывается
    // оператору и удаляется уборкой вместе с файлами — письмо исчезло бы молча.
    const parsed = mail({
      subject: 'Коммерческое предложение',
      attachments: [
        attachment({ filename: 'image001.png', contentType: 'image/png', content: PNG_SMALL }),
      ],
    });
    const result = await run(parsed);
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.status).toBe('quarantined');
    expect(result.keptAttachments).toBe(0);

    const [att] = await sql<{ state: string; staging_s3_key: string | null }[]>`
      SELECT state, staging_s3_key FROM mail_attachments
      WHERE mail_message_id = ${result.messageId}`;
    expect(att).toMatchObject({ state: 'suspected_signature' });
    expect(att!.staging_s3_key).not.toBeNull();
  });

  it('имя картинки подписи не подсказывает объект', async () => {
    // Иконка в пакет не идёт, и её имя не должно влиять на выбор площадки:
    // иначе логотип с «говорящим» именем отправил бы документы не туда.
    const parsed = mail({
      subject: 'Документы по поставке',
      attachments: [
        attachment({ content: PDF, filename: 'upd.pdf' }),
        attachment({ filename: 'АЛ13.png', contentType: 'image/png', content: PNG_SMALL }),
      ],
    });
    const result = await run(parsed);
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;

    const [msg] = await sql<{ suggested_site_id: string | null }[]>`
      SELECT suggested_site_id FROM mail_messages WHERE id = ${result.messageId}`;
    expect(msg!.suggested_site_id).toBeNull();
  });

  it('непригодное вложение не попадает в хранилище, но причина сохраняется', async () => {
    const parsed = mail({
      subject: 'Объект: ЗИЛ33',
      attachments: [attachment({ filename: 'счёт.pdf', content: EXE })],
    });
    const result = await run(parsed);
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.status).toBe('no_attachments');

    const [att] = await sql<{ state: string; staging_s3_key: string | null; skip_reason: string }[]>`
      SELECT state, staging_s3_key, skip_reason FROM mail_attachments
      WHERE mail_message_id = ${result.messageId}`;
    expect(att).toMatchObject({ state: 'skipped', staging_s3_key: null, skip_reason: 'unsupported_type' });
    // В S3 ушло только сырое письмо.
    expect(putObject).toHaveBeenCalledTimes(1);
  });

  it('без явного маркера объект остаётся подсказкой', async () => {
    const parsed = mail({
      subject: 'Документы',
      attachments: [attachment({ filename: 'Алия.pdf', content: PDF })],
    });
    const result = await run(parsed);
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    expect(result.match.decision).toBe('none');

    const [row] = await sql<{ suggested_site_id: string | null }[]>`
      SELECT suggested_site_id FROM mail_messages WHERE id = ${result.messageId}`;
    expect(row!.suggested_site_id).toBe(al13);
  });

  it('дата поставки распознаётся, если подрядчик её написал', async () => {
    const parsed = mail({
      subject: 'Объект: ЗИЛ33',
      text: 'Дата поставки: 05.08.2026',
      attachments: [attachment({ content: PDF })],
    });
    const result = await run(parsed);
    if (result.outcome !== 'stored') throw new Error('ожидалось stored');
    expect(result.expectedDate).toBe('2026-08-05');
  });

  it('сбой S3 не оставляет письмо в базе — повтор проходит начисто', async () => {
    putObject.mockRejectedValueOnce(new Error('S3 недоступен'));
    const parsed = mail({ subject: 'Объект: ЗИЛ33', attachments: [attachment({ content: PDF })] });
    const raw = Buffer.from('RAW-S3-FAIL');

    await expect(run(parsed, raw)).rejects.toThrow('S3 недоступен');
    const rows = await sql`SELECT id FROM mail_messages WHERE mail_account_id = ${accountId}`;
    expect(rows).toHaveLength(0);

    putObject.mockResolvedValue(undefined);
    const retry = await run(parsed, raw);
    expect(retry.outcome).toBe('stored');
  });

  it('ключи детерминированы: повтор пишет в те же объекты', async () => {
    const parsed = mail({ subject: 'Объект: ЗИЛ33', attachments: [attachment({ content: PDF })] });
    await run(parsed, Buffer.from('RAW-A'), 42);
    const keysFirst = putObject.mock.calls.map((c) => c[0]);

    await sql`DELETE FROM mail_messages WHERE mail_account_id = ${accountId}`;
    putObject.mockClear();
    await run(parsed, Buffer.from('RAW-A'), 42);
    const keysSecond = putObject.mock.calls.map((c) => c[0]);

    expect(keysSecond).toEqual(keysFirst);
    expect(keysFirst[0]).toContain(`mail/${accountId}/1/42/`);
  });
});
