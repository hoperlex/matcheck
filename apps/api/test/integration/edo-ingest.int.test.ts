/**
 * Приём документов из Диадока: реальный PostgreSQL, подменённые API и хранилище.
 *
 * Проверяется то, что нельзя увидеть на отдельных модулях: не создаётся ли
 * вторая карточка при повторе, не застревает ли ящик из-за вложения, которое мы
 * пока не разбираем, и доедет ли документ без объекта до планшета (не должен).
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  edoAccounts,
  edoReceipts,
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
} from '../../src/db/schema.js';
import { classifyMessageEntities } from '../../src/domain/edo/diadoc.entities.js';
import { claimReceipt } from '../../src/domain/edo/journal.js';
import { ingestEdoEntity } from '../../src/domain/edo/ingest-document.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import type { DiadocMessage } from '../../src/domain/edo/diadoc.types.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OUR_BOX = 'box-наш';

function updXml(docNumber: string, supplierInn = '7712345678'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерСчФ="${docNumber}" ДатаСчФ="01.09.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Поставщик»" ИННЮЛ="${supplierInn}" КПП="771201001"/></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО «СУ-10»" ИННЮЛ="7736030001" КПП="773601001"/></ИдСв></СвПокуп>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Труба" НаимЕдИзм="т" КолТов="2" ЦенаТов="1000"
               СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;
}

function message(messageId: string, entities: Record<string, unknown>[]): DiadocMessage {
  return {
    MessageId: messageId,
    FromBoxId: 'box-контрагента',
    ToBoxId: OUR_BOX,
    Entities: entities,
  } as DiadocMessage;
}

function utdEntity(entityId: string, docNumber: string) {
  return {
    EntityId: entityId,
    EntityType: 'Attachment',
    DocumentInfo: {
      TypeNamedId: 'UniversalTransferDocument',
      Function: 'СЧФДОП',
      Version: 'utd970_05_03_01',
      DocumentNumber: docNumber,
    },
  };
}

suite('приём документов из Диадока', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const puts: { key: string; size: number }[] = [];

  /** Хранилище подменяем: проверяем, что файл сохранён, а не как он летит в S3. */
  const put = vi.fn(async (key: string, body: Buffer) => {
    puts.push({ key, size: body.length });
  });

  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  /** Клиент, отдающий заранее заданное содержимое по идентификатору вложения. */
  function fakeClient(contents: Record<string, Buffer | Error>): DiadocClient {
    return {
      getEntityContent: vi.fn(async (_box: string, _msg: string, entityId: string) => {
        const value = contents[entityId];
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`нет содержимого для ${entityId}`);
        return value;
      }),
    } as unknown as DiadocClient;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    puts.length = 0;
    put.mockClear();
    accountId = randomUUID();
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `ЭДО ${accountId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: OUR_BOX,
    });
  });

  async function ingest(
    entityId: string,
    docNumber: string,
    contents: Record<string, Buffer | Error>,
    messageId = `msg-${entityId}`,
  ) {
    const [account] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    const classified = classifyMessageEntities(
      message(messageId, [utdEntity(entityId, docNumber)]),
      OUR_BOX,
    );
    const entity = classified.entities[0]!;
    const receipt = await claimReceipt(db, {
      accountId,
      eventId: `ev-${entityId}`,
      messageId,
      entityId,
      documentNumber: docNumber,
    });
    if (!receipt) return { outcome: 'claim_refused' as const };
    return ingestEdoEntity(
      { db, client: fakeClient(contents), log, put: put as never, xmlMaxBytes: 5_000_000 },
      { account: account!, receipt, entity, messageId },
    );
  }

  it('создаёт карточку с позициями, вложением и записью в журнале', async () => {
    const result = await ingest('ent-1', 'УТ-100', { 'ent-1': Buffer.from(updXml('УТ-100')) });
    expect(result).toMatchObject({ outcome: 'imported' });

    const docId = (result as { documentId: string }).documentId;
    const [doc] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId));
    expect(doc).toMatchObject({
      origin: 'edo_diadoc',
      status: 'parsed',
      docNumber: 'УТ-100',
      providerEntityId: 'ent-1',
    });
    // Объект и дата поставки не выдумываются: их проставляет мониторинг.
    expect(doc?.siteId).toBeNull();
    expect(doc?.expectedDate).toBeNull();

    const items = await db
      .select()
      .from(sourceDocumentItems)
      .where(eq(sourceDocumentItems.sourceDocumentId, docId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ nameRaw: 'Труба', unit: 'т' });

    const files = await db
      .select()
      .from(sourceDocumentAttachments)
      .where(eq(sourceDocumentAttachments.sourceDocumentId, docId));
    expect(files).toHaveLength(1);
    expect(files[0]?.role).toBe('original');
    expect(puts).toHaveLength(1);

    const [receipt] = await db
      .select()
      .from(edoReceipts)
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, 'ent-1')));
    expect(receipt).toMatchObject({ transportStatus: 'stored', routeStatus: 'imported' });
    expect(receipt?.sourceDocumentId).toBe(docId);
  });

  it('повторный проход не создаёт вторую карточку', async () => {
    const content = { 'ent-2': Buffer.from(updXml('УТ-200')) };
    const first = await ingest('ent-2', 'УТ-200', content);
    expect(first).toMatchObject({ outcome: 'imported' });

    // Второй заход по той же ленте: журнал уже закрыт, работа не выдаётся.
    const second = await ingest('ent-2', 'УТ-200', content);
    expect(second).toEqual({ outcome: 'claim_refused' });

    const docs = await db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.edoAccountId, accountId));
    expect(docs).toHaveLength(1);
  });

  it('сообщение с двумя документами даёт две карточки', async () => {
    const [account] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    const msg = message('msg-multi', [
      utdEntity('m-1', 'УТ-301'),
      utdEntity('m-2', 'УТ-302'),
    ]);
    const classified = classifyMessageEntities(msg, OUR_BOX);
    const client = fakeClient({
      'm-1': Buffer.from(updXml('УТ-301')),
      'm-2': Buffer.from(updXml('УТ-302')),
    });

    for (const entity of classified.entities) {
      const receipt = await claimReceipt(db, {
        accountId,
        eventId: 'ev-multi',
        messageId: 'msg-multi',
        entityId: entity.entityId,
      });
      await ingestEdoEntity(
        { db, client, log, put: put as never, xmlMaxBytes: 5_000_000 },
        { account: account!, receipt: receipt!, entity, messageId: 'msg-multi' },
      );
    }

    const docs = await db
      .select({ number: sourceDocuments.docNumber })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.edoAccountId, accountId));
    // Прежний индекс по паре «учётка + сообщение» пропустил бы только первый.
    expect(docs.map((d) => d.number).sort()).toEqual(['УТ-301', 'УТ-302']);
  });

  it('неразобранный документ сохраняется, но карточку не создаёт', async () => {
    // Документ разбирается БЕЗ исключения — поставщик на месте, — но номера и
    // позиций в нём нет. Именно так выглядит файл незнакомой версии: молча
    // «успешный» разбор, из которого нельзя собрать карточку.
    const broken = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<Файл><Документ>
  <СвСчФакт НомерСчФ="" ДатаСчФ="">
    <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Поставщик»" ИННЮЛ="7712345678"/></ИдСв></СвПрод>
  </СвСчФакт>
</Документ></Файл>`,
    );
    const result = await ingest('ent-broken', 'без номера', { 'ent-broken': broken });
    expect(result.outcome).toBe('unparsed');

    const docs = await db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.edoAccountId, accountId));
    expect(docs).toHaveLength(0);

    const [receipt] = await db
      .select()
      .from(edoReceipts)
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, 'ent-broken')));
    // Файл всё равно в хранилище: «не разобрали» не значит «потеряли».
    expect(receipt?.transportStatus).toBe('stored');
    expect(receipt?.rawS3Key).toBeTruthy();
    expect(receipt?.routeStatus).toBe('not_applicable');
    expect(receipt?.lastError).toContain('разбор неполон');
  });

  it('неформализованное вложение сохраняется и закрывается для курсора', async () => {
    const [account] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    const classified = classifyMessageEntities(
      message('msg-scan', [{ EntityId: 'scan-1', EntityType: 'Attachment', FileName: 'скан.pdf' }]),
      OUR_BOX,
    );
    const entity = classified.entities[0]!;
    expect(entity.route).toBe('unformalized');

    const receipt = await claimReceipt(db, {
      accountId,
      eventId: 'ev-scan',
      messageId: 'msg-scan',
      entityId: 'scan-1',
    });
    const result = await ingestEdoEntity(
      {
        db,
        client: fakeClient({ 'scan-1': Buffer.from('%PDF-1.4') }),
        log,
        put: put as never,
        xmlMaxBytes: 5_000_000,
      },
      { account: account!, receipt: receipt!, entity, messageId: 'msg-scan' },
    );
    expect(result).toEqual({ outcome: 'awaiting' });

    const [row] = await db
      .select()
      .from(edoReceipts)
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, 'scan-1')));
    // Транспорт закрыт — значит курсор пройдёт дальше и следующие УПД приедут.
    // Маршрут ждёт отдельно: разбор распознаванием включается флагом.
    expect(row?.transportStatus).toBe('stored');
    expect(row?.routeStatus).toBe('awaiting');
  });

  it('исчезнувший документ закрывается без карточки и без потери прохода', async () => {
    const { DiadocGone } = await import('../../src/domain/edo/diadoc.http.js');
    const result = await ingest('ent-gone', 'УТ-400', { 'ent-gone': new DiadocGone(410) });
    expect(result).toMatchObject({ outcome: 'skipped' });

    const [row] = await db
      .select()
      .from(edoReceipts)
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, 'ent-gone')));
    expect(row?.transportStatus).toBe('vanished');
  });
});
