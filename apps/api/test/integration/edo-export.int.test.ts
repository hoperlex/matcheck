/**
 * Выгрузка УПД по списку поставщиков — на настоящем PostgreSQL.
 *
 * Обещания, которые проверяются базой, а не чтением кода:
 *   - в хранилище ложатся только УПД продавцов из списка, по детерминированному
 *     ключу и с тем же sha256, что в реестре;
 *   - импорт не затронут: ни журнала приёма, ни карточек, ни контрагентов, ни
 *     курсора учётной записи;
 *   - повтор ничего не качает заново, а сбои и обрывы не теряют сделанного;
 *   - без лиза к Диадоку не уходит ни одного запроса.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { edoAccounts, edoExportDocuments } from '../../src/db/schema.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import { DiadocGone, DiadocPayloadTooLarge, DiadocTransient } from '../../src/domain/edo/diadoc.http.js';
import {
  dateToDiadocTicks,
  resolveEventTime,
  type DiadocBoxEvent,
} from '../../src/domain/edo/diadoc.types.js';
import {
  EdoExportStopped,
  EdoExportStorageFailed,
  EdoFeedStuck,
  exportUpdFromBox,
  type ExportPut,
} from '../../src/domain/edo/export-upd.js';
import { runEdoExport } from '../../src/domain/jobs/edo-poll-runner.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OUR_BOX = 'box-наш';
const THEIR_BOX = 'box-контрагента';
/** Продавцы: из списка, не из списка, второй из списка (для расширения). */
const LISTED = '7712345678';
const OTHER = '7736255508';
const LATER = '5906154545';
const SINCE = new Date('2026-09-21T21:00:00Z');
const AT = Date.UTC(2026, 8, 22, 6, 0);
const XML_MAX = 5 * 1024 * 1024;

function updXml(o: { number: string; sellers: string[]; date?: string }): Buffer {
  const sellers = o.sellers
    .map(
      (inn) =>
        `<СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Продавец ${inn}»" ИННЮЛ="${inn}" КПП="771201001"/></ИдСв></СвПрод>`,
    )
    .join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="${o.number}" ДатаДок="${o.date ?? '26.08.2026'}">${sellers}</СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Бетон" НаимЕдИзм="м3" КолТов="2" ЦенаТов="1000"
               СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="1"/>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000" СтТовУчНалВсего="2400"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`,
    'utf8',
  );
}

function ev(
  n: number,
  opts: { info?: Record<string, unknown>; at?: number; from?: string } = {},
): DiadocBoxEvent {
  return {
    EventId: `ev-${n}`,
    IndexKey: `ik-${String(n).padStart(4, '0')}`,
    Message: {
      MessageId: `msg-${n}`,
      FromBoxId: opts.from ?? THEIR_BOX,
      ToBoxId: OUR_BOX,
      TimestampTicks: dateToDiadocTicks(new Date(opts.at ?? AT + n * 60_000)),
      Entities: [
        {
          EntityId: `ent-${n}`,
          EntityType: 'Attachment',
          DocumentInfo: {
            TypeNamedId: 'UniversalTransferDocument',
            Function: 'СЧФДОП',
            Version: 'utd970_05_03_01',
            CounteragentBoxId: THEIR_BOX,
            ...opts.info,
          },
        },
        { EntityId: `sig-${n}`, EntityType: 'Signature', ParentEntityId: `ent-${n}` },
      ],
    },
  } as DiadocBoxEvent;
}

/**
 * Лента и содержимое. Лента честно режется по `fromTimestamp` и курсору;
 * `ignoreCursor` изображает ленту, которая отдаёт одну и ту же страницу.
 */
function fakeClient(
  feed: DiadocBoxEvent[],
  contentOf: (entityId: string) => Buffer | Error,
  opts: { onDownload?: (n: number) => Promise<void>; ignoreCursor?: boolean } = {},
) {
  let downloads = 0;
  const calls = {
    getNewEvents: vi.fn(
      async ({ afterIndexKey, fromTimestamp }: { afterIndexKey?: string | null; fromTimestamp?: Date | null }) => {
        const visible = feed.filter(
          (e) => !fromTimestamp || (resolveEventTime(e).at ?? new Date(0)) >= fromTimestamp,
        );
        const start =
          opts.ignoreCursor || !afterIndexKey ? 0 : visible.findIndex((e) => e.IndexKey === afterIndexKey) + 1;
        return { events: visible.slice(start, start + 100) };
      },
    ),
    getEntityContent: vi.fn(async (_box: string, _message: string, entityId: string) => {
      downloads += 1;
      await opts.onDownload?.(downloads);
      const content = contentOf(entityId);
      if (content instanceof Error) throw content;
      return content;
    }),
  };
  return { client: calls as unknown as DiadocClient, calls };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

suite('выгрузка УПД по списку поставщиков', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const createdAccounts: string[] = [];
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  /** Всё, что принадлежит импорту, — по всей базе. */
  async function footprint() {
    const [row] = await db.execute<Record<string, number>>(drSql`
      select (select count(*) from edo_events)::int as events,
             (select count(*) from edo_receipts)::int as receipts,
             (select count(*) from source_documents where origin = 'edo_diadoc')::int as docs,
             (select count(*) from counterparties)::int as counterparties
    `);
    return row;
  }

  async function account() {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    return row!;
  }

  async function rows() {
    return db
      .select()
      .from(edoExportDocuments)
      .where(eq(edoExportDocuments.edoAccountId, accountId))
      .orderBy(asc(edoExportDocuments.createdAt), asc(edoExportDocuments.entityId));
  }

  function exportDomain(
    client: DiadocClient,
    suppliers: Map<string, string>,
    opts: { since?: Date; put?: ExportPut; renewLease?: () => Promise<boolean> } = {},
  ) {
    return exportUpdFromBox(
      { db, client, log, put: opts.put ?? vi.fn(async () => {}), xmlMaxBytes: XML_MAX },
      {
        accountId,
        boxId: OUR_BOX,
        since: opts.since ?? SINCE,
        suppliers,
        renewLease: opts.renewLease ?? (async () => true),
      },
    );
  }

  const list = (...inns: string[]) => new Map(inns.map((inn) => [inn, `Из списка ${inn}`]));

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    if (createdAccounts.length > 0) {
      await db.delete(edoAccounts).where(inArray(edoAccounts.id, createdAccounts));
    }
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    accountId = randomUUID();
    createdAccounts.push(accountId);
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `ЭДО ${accountId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: OUR_BOX,
    });
  });

  it('выгружает только поставщиков из списка и не трогает импорт', async () => {
    const xml1 = updXml({ number: 'ЦБ-1', sellers: [LISTED] });
    const feed = [
      ev(1),
      ev(2),
      ev(3, { info: { TypeNamedId: 'Invoice', Function: 'default' } }),
      ev(4, { info: { TypeNamedId: 'Nonformalized', Function: 'default' } }),
      ev(5, { info: { IsTest: true } }),
      ev(6, { from: OUR_BOX }),
      ev(7, { info: { TypeNamedId: 'UniversalTransferDocumentRevision' } }),
    ];
    const contents: Record<string, Buffer> = {
      'ent-1': xml1,
      'ent-2': updXml({ number: 'ЦБ-2', sellers: [OTHER] }),
      'ent-7': updXml({ number: 'ЦБ-7', sellers: [LISTED] }),
    };
    const { client, calls } = fakeClient(feed, (id) => contents[id] ?? new Error(`не должен качаться: ${id}`));
    const put = vi.fn<ExportPut>(async () => {});
    const before = await footprint();

    const outcome = await runEdoExport(
      { db, log, owner: randomUUID(), createClient: () => client, put },
      accountId,
      { since: SINCE, suppliers: list(LISTED) },
    );

    expect(outcome).toMatchObject({
      ok: true,
      summary: { candidates: 3, stored: 2, notInList: 1, failed: 0, alreadyStored: 0, truncated: false },
    });
    expect(calls.getEntityContent.mock.calls.map((c) => c[2])).toEqual(['ent-1', 'ent-2', 'ent-7']);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]).toEqual([
      'edo-export/7712345678/2026-08-26_tsb-1_ent-1.xml',
      xml1,
      'application/xml',
      { sha256: sha(xml1) },
    ]);

    const saved = await rows();
    expect(saved.map((r) => [r.entityId, r.status, r.documentType])).toEqual([
      ['ent-1', 'stored', 'UniversalTransferDocument'],
      ['ent-2', 'not_in_list', 'UniversalTransferDocument'],
      ['ent-7', 'stored', 'UniversalTransferDocumentRevision'],
    ]);
    expect(saved[0]).toMatchObject({
      supplierInn: LISTED,
      supplierName: `ООО «Продавец ${LISTED}»`,
      sellerInns: [LISTED],
      documentNumber: 'ЦБ-1',
      documentFunction: 'СЧФДОП',
      totalSum: '2400.00',
      vatSum: '400.00',
      itemsCount: 1,
      contentCategory: 'materials',
      counteragentBoxId: THEIR_BOX,
      s3Key: 'edo-export/7712345678/2026-08-26_tsb-1_ent-1.xml',
      contentSha256: sha(xml1),
      sizeBytes: xml1.length,
      lastError: null,
    });
    expect(saved[0]!.documentDate!.toISOString().slice(0, 10)).toBe('2026-08-26');
    expect(saved[0]!.receivedAt).not.toBeNull();
    expect(saved[1]).toMatchObject({ supplierInn: OTHER, sellerInns: [OTHER], s3Key: null, contentSha256: null });

    // Импорт не затронут: ни журнала, ни карточек, ни контрагентов, ни курсора.
    expect(await footprint()).toEqual(before);
    const after = await account();
    expect(after).toMatchObject({
      pollLeaseToken: null,
      lastIndexKey: null,
      lastError: null,
      lastInventoryAt: null,
    });
  });

  it('повторный запуск ничего не качает заново', async () => {
    const feed = [ev(1), ev(2)];
    const contents: Record<string, Buffer> = {
      'ent-1': updXml({ number: '1', sellers: [LISTED] }),
      'ent-2': updXml({ number: '2', sellers: [OTHER] }),
    };
    await exportDomain(fakeClient(feed, (id) => contents[id]!).client, list(LISTED));

    const { client, calls } = fakeClient(feed, (id) => contents[id]!);
    const put = vi.fn<ExportPut>(async () => {});
    const summary = await exportDomain(client, list(LISTED), { put });

    expect(summary).toMatchObject({ candidates: 2, stored: 0, alreadyStored: 1, notInListKnown: 1, notInList: 0 });
    expect(calls.getEntityContent).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('список расширили — докачивается только документ нового поставщика', async () => {
    const feed = [ev(1), ev(2)];
    const contents: Record<string, Buffer> = {
      // Два продавца, в список позже попадает второй.
      'ent-1': updXml({ number: '1', sellers: [OTHER, LATER] }),
      'ent-2': updXml({ number: '2', sellers: [LISTED] }),
    };
    await exportDomain(fakeClient(feed, (id) => contents[id]!).client, list(LISTED));
    expect((await rows()).find((r) => r.entityId === 'ent-1')).toMatchObject({
      status: 'not_in_list',
      sellerInns: [OTHER, LATER],
    });

    const { client, calls } = fakeClient(feed, (id) => contents[id]!);
    const put = vi.fn<ExportPut>(async () => {});
    const summary = await exportDomain(client, list(LISTED, LATER), { put });

    expect(summary).toMatchObject({ stored: 1, alreadyStored: 1, notInListKnown: 0 });
    expect(calls.getEntityContent.mock.calls.map((c) => c[2])).toEqual(['ent-1']);
    expect(put.mock.calls[0]![0]).toBe(`edo-export/${LATER}/2026-08-26_1_ent-1.xml`);
    expect((await rows()).find((r) => r.entityId === 'ent-1')).toMatchObject({
      status: 'stored',
      supplierInn: LATER,
    });
  });

  it('более ранняя дата начала добавляет только старые документы', async () => {
    const feed = [ev(1, { at: Date.UTC(2026, 7, 10) }), ev(2, { at: Date.UTC(2026, 8, 25) })];
    const content = () => updXml({ number: 'N', sellers: [LISTED] });

    const first = fakeClient(feed, content);
    expect(await exportDomain(first.client, list(LISTED))).toMatchObject({ candidates: 1, stored: 1 });
    expect(first.calls.getEntityContent.mock.calls.map((c) => c[2])).toEqual(['ent-2']);

    const second = fakeClient(feed, content);
    const summary = await exportDomain(second.client, list(LISTED), { since: new Date('2026-07-31T21:00:00Z') });
    expect(summary).toMatchObject({ candidates: 2, stored: 1, alreadyStored: 1 });
    expect(second.calls.getEntityContent.mock.calls.map((c) => c[2])).toEqual(['ent-1']);
  });

  it('сбой документа отмечается с причиной и не останавливает обход', async () => {
    const feed = [ev(1), ev(2), ev(3), ev(4), ev(5)];
    const contents: Record<string, Buffer | Error> = {
      'ent-1': new DiadocGone(404),
      'ent-2': new DiadocPayloadTooLarge(XML_MAX),
      'ent-3': Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Файл ИдФайл="x"></Файл>', 'utf8'),
      'ent-4': Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n', 'latin1'),
      'ent-5': updXml({ number: '5', sellers: [LISTED] }),
    };
    const summary = await exportDomain(fakeClient(feed, (id) => contents[id]!).client, list(LISTED));

    expect(summary).toMatchObject({ candidates: 5, stored: 1, failed: 4 });
    const byEntity = Object.fromEntries((await rows()).map((r) => [r.entityId, r]));
    expect(byEntity['ent-1']).toMatchObject({ status: 'failed', lastError: 'документ исчез из Диадока' });
    expect(byEntity['ent-2']).toMatchObject({ status: 'failed', lastError: 'файл больше 5 МБ' });
    expect(byEntity['ent-3']!.lastError).toMatch(/^разбор: /);
    expect(byEntity['ent-4']!.lastError).toMatch(/^вложение не XML/);
    expect(byEntity['ent-5']).toMatchObject({ status: 'stored' });
  });

  it('обрыв связи останавливает обход, повтор дорабатывает без повторных скачиваний', async () => {
    const feed = Array.from({ length: 150 }, (_, i) => ev(i + 1));
    const content = (id: string) => updXml({ number: id, sellers: [LISTED] });

    const broken = fakeClient(feed, (id) =>
      id === 'ent-120' ? new DiadocTransient('обрыв', { endpoint: 'GetEntityContent' }) : content(id),
    );
    const stopped = await exportDomain(broken.client, list(LISTED)).catch((err: unknown) => err);
    expect(stopped).toBeInstanceOf(EdoExportStopped);
    expect((stopped as EdoExportStopped).reason).toBeInstanceOf(DiadocTransient);
    expect((stopped as EdoExportStopped).summary).toMatchObject({ pages: 1, stored: 119 });
    expect((await rows()).filter((r) => r.status === 'stored')).toHaveLength(119);

    const healthy = fakeClient(feed, content);
    const summary = await exportDomain(healthy.client, list(LISTED));
    expect(summary).toMatchObject({ candidates: 150, stored: 31, alreadyStored: 119, failed: 0 });
    expect(healthy.calls.getEntityContent).toHaveBeenCalledTimes(31);
    expect((await rows()).filter((r) => r.status === 'stored')).toHaveLength(150);
  });

  it('хранилище не приняло файл — строки нет, повтор пишет тот же ключ', async () => {
    const feed = [ev(1)];
    const content = () => updXml({ number: '1', sellers: [LISTED] });
    const failingPut = vi.fn<ExportPut>(async () => {
      throw new Error('S3 PUT failed: HTTP 503');
    });

    const stopped = await exportDomain(fakeClient(feed, content).client, list(LISTED), { put: failingPut }).catch(
      (err: unknown) => err,
    );
    expect((stopped as EdoExportStopped).reason).toBeInstanceOf(EdoExportStorageFailed);
    expect(await rows()).toHaveLength(0);

    const put = vi.fn<ExportPut>(async () => {});
    await exportDomain(fakeClient(feed, content).client, list(LISTED), { put });
    expect(put.mock.calls[0]![0]).toBe(failingPut.mock.calls[0]![0]);
    expect(await rows()).toMatchObject([{ status: 'stored', s3Key: put.mock.calls[0]![0] }]);
  });

  it('лиз перехвачен — после этого к Диадоку не уходит ни одного запроса', async () => {
    const feed = Array.from({ length: 10 }, (_, i) => ev(i + 1));
    const { client, calls } = fakeClient(
      feed,
      () => updXml({ number: 'N', sellers: [LISTED] }),
      {
        onDownload: async (n) => {
          // Другой процесс забрал учётку: у лиза другой токен.
          if (n === 3) {
            await db.update(edoAccounts).set({ pollLeaseToken: randomUUID() }).where(eq(edoAccounts.id, accountId));
          }
        },
      },
    );

    const outcome = await runEdoExport(
      { db, log, owner: randomUUID(), createClient: () => client, put: vi.fn(async () => {}) },
      accountId,
      { since: SINCE, suppliers: list(LISTED) },
    );

    expect(outcome).toMatchObject({ skipped: 'lease_lost', summary: { stored: 3 } });
    expect(calls.getEntityContent).toHaveBeenCalledTimes(3);
    expect(calls.getNewEvents).toHaveBeenCalledTimes(1);
    expect((await account()).lastError).toBeNull();
  });

  it('лиз продлевается перед каждым запросом к Диадоку', async () => {
    const feed = [ev(1), ev(2), ev(3)];
    const { client, calls } = fakeClient(feed, () => updXml({ number: 'N', sellers: [LISTED] }));
    const renewLease = vi.fn(async () => true);

    await exportDomain(client, list(LISTED), { renewLease });

    // Страница с событиями, пустая страница и три скачивания.
    expect(calls.getNewEvents).toHaveBeenCalledTimes(2);
    expect(calls.getEntityContent).toHaveBeenCalledTimes(3);
    expect(renewLease).toHaveBeenCalledTimes(5);
  });

  it('лента отдала ту же страницу — обход останавливается, а не ходит по кругу', async () => {
    const feed = [ev(1), ev(2)];
    const { client, calls } = fakeClient(feed, () => updXml({ number: 'N', sellers: [LISTED] }), {
      ignoreCursor: true,
    });

    const stopped = await exportDomain(client, list(LISTED)).catch((err: unknown) => err);

    expect((stopped as EdoExportStopped).reason).toBeInstanceOf(EdoFeedStuck);
    expect(calls.getNewEvents).toHaveBeenCalledTimes(2);
    expect(calls.getEntityContent).toHaveBeenCalledTimes(2);
  });

  it('база не принимает «выгружено» без файла', async () => {
    await expect(
      db.insert(edoExportDocuments).values({
        edoAccountId: accountId,
        messageId: 'm',
        entityId: 'e',
        documentType: 'UniversalTransferDocument',
        status: 'stored',
      }),
    ).rejects.toThrow();
  });
});
