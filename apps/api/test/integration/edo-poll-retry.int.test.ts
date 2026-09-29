/**
 * Проход по ленте Диадока: повторы, курсор и выключатель — на настоящем
 * PostgreSQL, с подменёнными API и хранилищем.
 *
 * Повод — P0, найденный ревью 25.09.2026. После сбоя конкретного документа
 * событие получало `failed`, повторный захват брал только `pending`, и на
 * втором проходе событие приходило с пустым списком вложений — а пустой список
 * терминален. Курсор уходил дальше, квитанция навсегда оставалась в `fetching`,
 * и из пяти обещанных попыток срабатывала одна. Здесь проверяется гарантия,
 * ради которой всё это затевалось: событие либо обработано, либо повторяется и
 * не пропускается.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Импорт включается ДО загрузки модулей: окружение читается один раз и
// кешируется, а хранилище читает его уже при импорте. Выключенный импорт
// проверяется в конце файла на свежих экземплярах модулей.
vi.hoisted(() => {
  process.env.EDO_IMPORT_ENABLED = '1';
});

import type { Db } from '../../src/db/client.js';
import { edoAccounts, edoEvents, edoReceipts, sourceDocuments } from '../../src/db/schema.js';
import { pollEdoAccount } from '../../src/domain/jobs/edo-poll.js';
import { claimEvent, claimReceipt } from '../../src/domain/edo/journal.js';
import { acquireEdoLease, releaseEdoLease } from '../../src/domain/edo/poll-lease.js';
import { DiadocTransient } from '../../src/domain/edo/diadoc.http.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import type { DiadocBoxEvent } from '../../src/domain/edo/diadoc.types.js';
import type * as IngestModule from '../../src/domain/edo/ingest-document.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OUR_BOX = 'box-наш';

function updXml(docNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерСчФ="${docNumber}" ДатаСчФ="01.09.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Поставщик»" ИННЮЛ="7712345678" КПП="771201001"/></ИдСв></СвПрод>
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

type Attachment = { id: string; number?: string; pdf?: boolean };

/** Событие ленты с сообщением. IndexKey растёт вместе с номером. */
function feedEvent(n: number, attachments: Attachment[]): DiadocBoxEvent {
  return {
    EventId: `ev-${n}`,
    IndexKey: `ik-${String(n).padStart(4, '0')}`,
    Message: {
      MessageId: `msg-${n}`,
      FromBoxId: 'box-контрагента',
      ToBoxId: OUR_BOX,
      Entities: attachments.map((a) =>
        a.pdf
          ? { EntityId: a.id, EntityType: 'Attachment', FileName: `${a.id}.pdf` }
          : {
              EntityId: a.id,
              EntityType: 'Attachment',
              DocumentInfo: {
                TypeNamedId: 'UniversalTransferDocument',
                Function: 'СЧФДОП',
                Version: 'utd970_05_03_01',
                DocumentNumber: a.number ?? a.id,
              },
            },
      ),
    },
  } as DiadocBoxEvent;
}

/** Содержимое вложения: готовый ответ или функция, решающая на каждой попытке. */
type Content = Buffer | Error | (() => Buffer | Error);

/** Документный отказ: так выглядит 4xx на конкретный документ. */
const documentFailure = () => new Error('Diadoc: запрос отклонён (HTTP 400)');

suite('проход по ленте Диадока: повторы и курсор', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const createdAccounts: string[] = [];

  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  /** Хранилище подменяем: проверяем, что и как сохранено, а не полёт в S3. */
  let putImpl: (key: string, body: Buffer, contentType: string) => Promise<void>;
  const puts: { key: string; size: number; contentType: string }[] = [];
  const put = vi.fn(async (key: string, body: Buffer, contentType: string) => {
    await putImpl(key, body, contentType);
    puts.push({ key, size: body.length, contentType });
  });

  function fakeClient(feed: DiadocBoxEvent[], contents: Record<string, Content>) {
    const downloads: string[] = [];
    const client = {
      getNewEvents: vi.fn(async ({ afterIndexKey }: { afterIndexKey?: string | null }) => {
        const start = afterIndexKey ? feed.findIndex((e) => e.IndexKey === afterIndexKey) + 1 : 0;
        return { events: feed.slice(start) };
      }),
      getEntityContent: vi.fn(async (_box: string, _msg: string, entityId: string) => {
        downloads.push(entityId);
        const content = contents[entityId];
        const value = typeof content === 'function' ? content() : content;
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`нет содержимого для ${entityId}`);
        return value;
      }),
    } as unknown as DiadocClient;
    return { client, downloads };
  }

  function poll(client: DiadocClient) {
    return pollEdoAccount(
      { db, log, owner: randomUUID(), createClient: () => client, put: put as never },
      accountId,
      { manual: true },
    );
  }

  async function account() {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    return row!;
  }

  async function receipt(entityId: string) {
    const [row] = await db
      .select()
      .from(edoReceipts)
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, entityId)));
    return row;
  }

  async function eventStatus(eventId: string) {
    const [row] = await db
      .select({ status: edoEvents.status })
      .from(edoEvents)
      .where(and(eq(edoEvents.edoAccountId, accountId), eq(edoEvents.eventId, eventId)));
    return row?.status;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    if (createdAccounts.length > 0) {
      await db.delete(sourceDocuments).where(inArray(sourceDocuments.edoAccountId, createdAccounts));
      await db.delete(edoAccounts).where(inArray(edoAccounts.id, createdAccounts));
    }
    delete process.env.EDO_IMPORT_ENABLED;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    puts.length = 0;
    put.mockClear();
    putImpl = async () => {};
    accountId = randomUUID();
    createdAccounts.push(accountId);
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `ЭДО ${accountId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: OUR_BOX,
    });
  });

  it('сбой документа тратит попытку, курсор стоит, следующий проход повторяет', async () => {
    let attempt = 0;
    const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-1' }])];
    const contents = {
      'ent-a': () => (++attempt === 1 ? documentFailure() : Buffer.from(updXml('УТ-1'))),
    };

    const first = await poll(fakeClient(feed, contents).client);
    expect(first.skipped).toBeUndefined();
    expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'failed', attempts: 1 });
    expect(await eventStatus('ev-1')).toBe('failed');
    expect((await account()).lastIndexKey).toBeNull();
    // Сбой документа — не неисправность учётной записи: её не красим «ошибкой».
    expect((await account()).lastError).toBeNull();

    const second = await poll(fakeClient(feed, contents).client);
    expect(second.imported).toBe(1);
    expect(await receipt('ent-a')).toMatchObject({
      transportStatus: 'stored',
      routeStatus: 'imported',
      attempts: 2,
    });
    expect(await eventStatus('ev-1')).toBe('processed');
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });

  it('несколько вложений в одном событии: курсор ждёт все', async () => {
    let bAttempt = 0;
    const feed = [
      feedEvent(1, [
        { id: 'ent-a', number: 'УТ-11' },
        { id: 'ent-b', number: 'УТ-12' },
      ]),
      feedEvent(2, [{ id: 'ent-c', number: 'УТ-13' }]),
    ];
    const contents = {
      'ent-a': Buffer.from(updXml('УТ-11')),
      'ent-b': () => (++bAttempt === 1 ? documentFailure() : Buffer.from(updXml('УТ-12'))),
      'ent-c': Buffer.from(updXml('УТ-13')),
    };

    await poll(fakeClient(feed, contents).client);
    expect(await receipt('ent-a')).toMatchObject({ routeStatus: 'imported' });
    expect(await receipt('ent-b')).toMatchObject({ transportStatus: 'failed' });
    // Следующее событие обработано, но курсор его не проходит: впереди
    // незакрытое, и перешагнуть его значит потерять документ.
    expect((await account()).lastIndexKey).toBeNull();

    const { client, downloads } = fakeClient(feed, contents);
    await poll(client);
    // Повторяется только незакрытое; сохранённое второй раз не качается.
    expect(downloads).toEqual(['ent-b']);
    expect(await receipt('ent-b')).toMatchObject({ routeStatus: 'imported' });
    expect((await account()).lastIndexKey).toBe('ik-0002');
  });

  it('хранилище не приняло файл: проход остановлен, попытка не израсходована', async () => {
    const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-21' }])];
    const contents = { 'ent-a': Buffer.from(updXml('УТ-21')) };
    putImpl = async () => {
      throw new Error('S3 PUT failed: 503');
    };

    const first = await poll(fakeClient(feed, contents).client);
    expect(first.skipped).toBe('storage');
    expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'fetching', attempts: 0 });
    expect(await eventStatus('ev-1')).toBe('pending');
    expect((await account()).lastIndexKey).toBeNull();
    // Инфраструктурный сбой виден на учётной записи — чинить его человеку.
    expect((await account()).lastError).toMatch(/хранилище не приняло файл/);

    putImpl = async () => {};
    const second = await poll(fakeClient(feed, contents).client);
    expect(second.imported).toBe(1);
    expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'stored', attempts: 1 });
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });

  it('временный сбой Диадока попытку не расходует', async () => {
    const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-31' }])];
    const result = await poll(
      fakeClient(feed, { 'ent-a': new DiadocTransient('соединение оборвано (ECONNRESET)') }).client,
    );
    expect(result.skipped).toBe('upstream');
    expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'fetching', attempts: 0 });
    expect(await eventStatus('ev-1')).toBe('pending');
  });

  it('процесс упал посреди обработки — следующий проход подхватывает вложение', async () => {
    // Состояние после падения: событие открыто, вложение в `fetching` с
    // израсходованной попыткой.
    await claimEvent(db, { accountId, eventId: 'ev-1', indexKey: 'ik-0001', kind: 'message', eventAt: null });
    await claimReceipt(db, { accountId, eventId: 'ev-1', messageId: 'msg-1', entityId: 'ent-a' });

    const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-41' }])];
    const result = await poll(fakeClient(feed, { 'ent-a': Buffer.from(updXml('УТ-41')) }).client);
    expect(result.imported).toBe(1);
    expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'stored', attempts: 2 });
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });

  it('пять документных сбоев — вложение терминально, курсор идёт дальше', async () => {
    const feed = [
      feedEvent(1, [{ id: 'ent-a', number: 'УТ-51' }]),
      feedEvent(2, [{ id: 'ent-b', number: 'УТ-52' }]),
    ];
    const contents = { 'ent-a': documentFailure, 'ent-b': Buffer.from(updXml('УТ-52')) };

    for (let i = 1; i <= 4; i++) {
      await poll(fakeClient(feed, contents).client);
      expect(await receipt('ent-a')).toMatchObject({ transportStatus: 'failed', attempts: i });
      expect((await account()).lastIndexKey).toBeNull();
    }

    await poll(fakeClient(feed, contents).client);
    // Пятая неудача: вложение закрыто видимым `failed`, лента идёт дальше.
    const a = await receipt('ent-a');
    expect(a).toMatchObject({ transportStatus: 'failed', attempts: 5 });
    expect(a?.lastError).toMatch(/HTTP 400/);
    expect(await eventStatus('ev-1')).toBe('processed');
    expect(await receipt('ent-b')).toMatchObject({ routeStatus: 'imported' });
    expect((await account()).lastIndexKey).toBe('ik-0002');

    // Шестого раза нет: терминальное вложение больше не качается.
    const { client, downloads } = fakeClient(feed, contents);
    await poll(client);
    expect(downloads).toEqual([]);
  });

  it('вложение, зависшее в `fetching` с исчерпанными попытками, закрывается', async () => {
    // Процесс падал пять раз подряд: попытки кончились, а запись так и
    // осталась в `fetching`. Прежде такое вложение останавливало ленту навсегда.
    await claimEvent(db, { accountId, eventId: 'ev-1', indexKey: 'ik-0001', kind: 'message', eventAt: null });
    await claimReceipt(db, { accountId, eventId: 'ev-1', messageId: 'msg-1', entityId: 'ent-a' });
    await db
      .update(edoReceipts)
      .set({ attempts: 5 })
      .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.entityId, 'ent-a')));

    const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-61' }])];
    const { client, downloads } = fakeClient(feed, { 'ent-a': Buffer.from(updXml('УТ-61')) });
    await poll(client);

    expect(downloads).toEqual([]);
    const a = await receipt('ent-a');
    expect(a).toMatchObject({ transportStatus: 'failed', attempts: 5 });
    expect(a?.lastError).toMatch(/попытки исчерпаны/);
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });

  it('второй одновременный проход не начинается: учётка занята', async () => {
    const lease = await acquireEdoLease(db, {
      accountId,
      owner: randomUUID(),
      ttlSeconds: 60,
      requirePollEnabled: false,
    });
    expect(lease).not.toBeNull();
    try {
      const feed = [feedEvent(1, [{ id: 'ent-a', number: 'УТ-71' }])];
      const { client, downloads } = fakeClient(feed, { 'ent-a': Buffer.from(updXml('УТ-71')) });
      const result = await poll(client);
      expect(result.skipped).toBe('lease_taken');
      expect(downloads).toEqual([]);
      expect(await receipt('ent-a')).toBeUndefined();
    } finally {
      await releaseEdoLease(db, lease!);
    }
  });

  it('PDF крупнее предела XML сохраняется как PDF и ждёт распознавания', async () => {
    // 6 МБ — больше прежнего общего предела 5 МБ, меньше предела файлов 25 МБ.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024, 0x20)]);
    const feed = [feedEvent(1, [{ id: 'scan-1', pdf: true }])];

    const result = await poll(fakeClient(feed, { 'scan-1': pdf }).client);
    expect(result.awaiting).toBe(1);

    const row = await receipt('scan-1');
    expect(row).toMatchObject({
      transportStatus: 'stored',
      routeStatus: 'awaiting',
      mimeType: 'application/pdf',
      originalFilename: 'scan-1.pdf',
      sizeBytes: pdf.length,
    });
    expect(row?.rawS3Key).toMatch(/\/original\.pdf$/);
    // В ключе хранилища нет ничего, что задаёт отправитель.
    expect(row?.rawS3Key).toContain(row!.id);
    expect(puts[0]?.contentType).toBe('application/pdf');
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });

  it('не материалы: квитанция с причиной, счёт-фактура не скачивается, подпись не пишется', async () => {
    // Прежде всё, что не УПД, шло в «неформализованные» и скачивалось, а
    // исключённое пропускалось без записи — ответа «а где документ?» не было.
    const utdInfo = {
      TypeNamedId: 'UniversalTransferDocument',
      Function: 'СЧФДОП',
      Version: 'utd970_05_03_01',
    };
    const feed = [
      {
        EventId: 'ev-1',
        IndexKey: 'ik-0001',
        Message: {
          MessageId: 'msg-1',
          FromBoxId: 'box-контрагента',
          ToBoxId: OUR_BOX,
          Entities: [
            {
              EntityId: 'inv',
              EntityType: 'Attachment',
              DocumentInfo: { TypeNamedId: 'Invoice', Function: 'default', Version: 'invoice_05_02_01' },
            },
            { EntityId: 'srv', EntityType: 'Attachment', DocumentInfo: utdInfo },
            { EntityId: 'mat', EntityType: 'Attachment', DocumentInfo: utdInfo },
            { EntityId: 'tst', EntityType: 'Attachment', DocumentInfo: { ...utdInfo, IsTest: true } },
            { EntityId: 'sig', EntityType: 'Signature', ParentEntityId: 'mat' },
          ],
        },
      } as DiadocBoxEvent,
    ];
    const services = updXml('УТ-2').replace(
      '<СумНал><СумНал>400</СумНал></СумНал>',
      '<СумНал><СумНал>400</СумНал></СумНал><ДопСведТов ПрТовРаб="3"/>',
    );
    const { client, downloads } = fakeClient(feed, {
      srv: Buffer.from(services),
      mat: Buffer.from(updXml('УТ-3')),
    });

    const result = await poll(client);

    // Скачаны только УПД-кандидаты.
    expect(downloads).toEqual(['srv', 'mat']);
    expect(result.imported).toBe(1);
    expect(await receipt('inv')).toMatchObject({
      transportStatus: 'skipped',
      routeStatus: 'not_applicable',
      lastError: 'счёт-фактура (Invoice)',
    });
    expect(await receipt('tst')).toMatchObject({ transportStatus: 'skipped', lastError: 'тестовый документ' });
    const srv = await receipt('srv');
    expect(srv).toMatchObject({ transportStatus: 'stored', routeStatus: 'not_applicable' });
    expect(srv?.lastError).toMatch(/^работы или услуги:/);
    expect(srv?.sourceDocumentId).toBeNull();
    expect(await receipt('mat')).toMatchObject({ routeStatus: 'imported' });
    expect(await receipt('sig')).toBeUndefined();

    // Карточка — одна, с суммой С НДС, как во всём портале.
    const docs = await db
      .select({ totalSum: sourceDocuments.totalSum, docNumber: sourceDocuments.docNumber })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.edoAccountId, accountId));
    expect(docs).toEqual([{ totalSum: '2400.00', docNumber: 'УТ-3' }]);

    expect(await eventStatus('ev-1')).toBe('processed');
    expect((await account()).lastIndexKey).toBe('ik-0001');
  });
});

suite('выключенный импорт', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  const accountId = randomUUID();

  // Свежие экземпляры модулей с EDO_IMPORT_ENABLED=0: окружение кешируется
  // при первом чтении, поэтому без сброса модулей флаг не переключить.
  let pollOff: typeof pollEdoAccount;
  let ingestOff: typeof IngestModule.ingestEdoEntity;
  let ImportDisabled: typeof IngestModule.EdoImportDisabled;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql) as unknown as Db;
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `ЭДО выкл ${accountId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: OUR_BOX,
    });

    process.env.EDO_IMPORT_ENABLED = '0';
    vi.resetModules();
    pollOff = (await import('../../src/domain/jobs/edo-poll.js')).pollEdoAccount;
    const ingestModule = await import('../../src/domain/edo/ingest-document.js');
    ingestOff = ingestModule.ingestEdoEntity;
    ImportDisabled = ingestModule.EdoImportDisabled;
  });

  afterAll(async () => {
    delete process.env.EDO_IMPORT_ENABLED;
    await db.delete(edoAccounts).where(eq(edoAccounts.id, accountId));
    await sql.end({ timeout: 5 });
  });

  it('проход не начинается: ни ленты, ни курсора, ни «ошибки» на учётке', async () => {
    const getNewEvents = vi.fn();
    const client = { getNewEvents, getEntityContent: vi.fn() } as unknown as DiadocClient;
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

    const result = await pollOff(
      { db, log, owner: randomUUID(), createClient: () => client },
      accountId,
      { manual: true },
    );

    expect(result.skipped).toBe('import_disabled');
    expect(getNewEvents).not.toHaveBeenCalled();
    const events = await db.select().from(edoEvents).where(eq(edoEvents.edoAccountId, accountId));
    expect(events).toHaveLength(0);
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    expect(row?.lastIndexKey).toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it('прямой вызов приёма документа упирается в выключатель и ничего не создаёт', async () => {
    const [account] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    const receiptRow = await claimReceipt(db, {
      accountId,
      eventId: 'ev-off',
      messageId: 'msg-off',
      entityId: 'ent-off',
    });
    const getEntityContent = vi.fn();
    const client = { getEntityContent } as unknown as DiadocClient;
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

    await expect(
      ingestOff(
        { db, client, log, put: vi.fn() as never, xmlMaxBytes: 5_000_000, fileMaxBytes: 25_000_000 },
        {
          account: account!,
          receipt: receiptRow!,
          entity: {
            entityId: 'ent-off',
            route: 'utd_xml',
            reason: 'формализованный УПД',
            typeNamedId: 'UniversalTransferDocument',
            documentFunction: 'СЧФДОП',
            documentVersion: 'utd970_05_03_01',
            documentNumber: 'УТ-OFF',
            documentDate: null,
            fileName: null,
            counteragentBoxId: null,
            isEncrypted: false,
          },
          messageId: 'msg-off',
        },
      ),
    ).rejects.toBeInstanceOf(ImportDisabled);

    // Ничего не скачано и не создано: выключатель стоит до первой записи.
    expect(getEntityContent).not.toHaveBeenCalled();
    const docs = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.edoAccountId, accountId));
    expect(docs).toHaveLength(0);
  });
});
