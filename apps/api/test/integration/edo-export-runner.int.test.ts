/**
 * Автообновление реестра УПД из ЭДО (edo-export-runner) — на настоящем PostgreSQL.
 *
 * Обещания, которые проверяются базой:
 *   - курсор двигается только после полностью обработанной страницы и только
 *     под своим, не истёкшим лизом;
 *   - курсор от другого ящика не используется молча — проход не читает ленту;
 *   - перепись не качает файлов и не задваивается; перепись и выгрузка по
 *     списку курсор не трогают;
 *   - сбои повторяются по расписанию и закрываются, когда повторять нечего;
 *   - каждый проход оставляет строку журнала с честным исходом.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  edoAccounts,
  edoExportCensus,
  edoExportCursors,
  edoExportDocuments,
  edoExportRuns,
} from '../../src/db/schema.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import { DiadocGone, DiadocTransient } from '../../src/domain/edo/diadoc.http.js';
import {
  dateToDiadocTicks,
  resolveEventTime,
  type DiadocBoxEvent,
  type DiadocMessage,
} from '../../src/domain/edo/diadoc.types.js';
import type { ExportPut } from '../../src/domain/edo/export-upd.js';
import {
  EXPORT_FEED_QUERY,
  isExportStuck,
  parseSince,
  runEdoExportPass,
  type ExportRunMode,
} from '../../src/domain/jobs/edo-export-runner.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OUR_BOX = 'box-наш';
const THEIR_BOX = 'box-контрагента';
const SELLER = '7712345678';
/** События после EDO_EXPORT_SINCE по умолчанию (05.10.2026). */
const AT = Date.UTC(2026, 9, 6, 6, 0);

function updXml(number: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="${number}" ДатаДок="06.10.2026"><СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Продавец»" ИННЮЛ="${SELLER}" КПП="771201001"/></ИдСв></СвПрод></СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Бетон" НаимЕдИзм="м3" КолТов="2" ЦенаТов="1000" СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал><ДопСведТов ПрТовРаб="1"/>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000" СтТовУчНалВсего="2400"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`,
    'utf8',
  );
}

/** Событие с УПД; `scan` — неформализованный документ вместо УПД. */
function ev(n: number, opts: { scan?: boolean } = {}): DiadocBoxEvent {
  return {
    EventId: `ev-${n}`,
    IndexKey: `ik-${String(n).padStart(4, '0')}`,
    Message: {
      MessageId: `msg-${n}`,
      FromBoxId: THEIR_BOX,
      FromTitle: 'ООО «ТПК ПромАэроТехника»',
      ToBoxId: OUR_BOX,
      TimestampTicks: dateToDiadocTicks(new Date(AT + n * 60_000)),
      Entities: [
        {
          EntityId: `ent-${n}`,
          EntityType: 'Attachment',
          FileName: opts.scan ? `УПД ТК-${n}.pdf` : undefined,
          Content: { Size: 1000 + n },
          DocumentInfo: opts.scan
            ? { TypeNamedId: 'Nonformalized', Function: 'default', CounteragentBoxId: THEIR_BOX }
            : {
                TypeNamedId: 'UniversalTransferDocument',
                Function: 'СЧФДОП',
                Version: 'utd970_05_03_01',
                CounteragentBoxId: THEIR_BOX,
              },
        },
      ],
    },
  } as DiadocBoxEvent;
}

function fakeClient(
  feed: DiadocBoxEvent[],
  contentOf: (entityId: string) => Buffer | Error = (id) => updXml(id),
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
    getMessage: vi.fn(async (_box: string, messageId: string): Promise<DiadocMessage> => {
      const message = feed.find((e) => e.Message?.MessageId === messageId)?.Message;
      if (!message) throw new DiadocGone(404);
      return message as DiadocMessage;
    }),
  };
  return { client: calls as unknown as DiadocClient, calls };
}

const FULL: ExportRunMode = { scope: 'all', trigger: 'auto', maxEvents: 5000, maxDownloads: 500 };

suite('автообновление реестра УПД из ЭДО', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const createdAccounts: string[] = [];
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  function run(client: DiadocClient, mode: ExportRunMode = FULL, extra: { signal?: AbortSignal; put?: ExportPut } = {}) {
    return runEdoExportPass(
      { db, log, owner: randomUUID(), createClient: () => client, put: extra.put ?? vi.fn(async () => {}), signal: extra.signal },
      accountId,
      mode,
    );
  }

  async function cursor() {
    const [row] = await db.select().from(edoExportCursors).where(eq(edoExportCursors.edoAccountId, accountId));
    return row ?? null;
  }

  async function runs() {
    return db
      .select()
      .from(edoExportRuns)
      .where(eq(edoExportRuns.edoAccountId, accountId))
      .orderBy(asc(edoExportRuns.startedAt));
  }

  async function docs() {
    return db
      .select()
      .from(edoExportDocuments)
      .where(eq(edoExportDocuments.edoAccountId, accountId))
      .orderBy(asc(edoExportDocuments.entityId));
  }

  async function lease() {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    return row!.pollLeaseToken;
  }

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

  it('первый проход создаёт курсор, двигает его по страницам и пишет журнал', async () => {
    const feed = [ev(1), ev(2, { scan: true }), ev(3)];
    const { client, calls } = fakeClient(feed);

    const result = await run(client);

    expect(result).toMatchObject({ outcome: 'completed', error: null });
    expect(calls.getNewEvents.mock.calls[0]![0]).toMatchObject({
      afterIndexKey: null,
      fromTimestamp: parseSince('2026-10-05'),
    });
    expect(await cursor()).toMatchObject({
      boxId: OUR_BOX,
      feedQuery: EXPORT_FEED_QUERY,
      indexKey: 'ik-0003',
    });
    const [journal] = await runs();
    expect(journal).toMatchObject({
      scope: 'all',
      trigger: 'auto',
      outcome: 'completed',
      indexKeyBefore: null,
      indexKeyAfter: 'ik-0003',
      eventsSeen: 3,
      stored: 2,
      census: 1,
      truncateReason: null,
    });
    expect(journal!.feedCompletedAt).not.toBeNull();
    expect((await docs()).map((d) => [d.entityId, d.status])).toEqual([
      ['ent-1', 'stored'],
      ['ent-3', 'stored'],
    ]);
    expect(await lease()).toBeNull();
  });

  it('следующий проход идёт с сохранённого ключа и качает только новое', async () => {
    const feed = [ev(1), ev(2)];
    await run(fakeClient(feed).client);

    feed.push(ev(3), ev(4));
    const { client, calls } = fakeClient(feed);
    const result = await run(client);

    expect(calls.getNewEvents.mock.calls[0]![0]).toMatchObject({ afterIndexKey: 'ik-0002' });
    expect(calls.getEntityContent.mock.calls.map((c) => c[2])).toEqual(['ent-3', 'ent-4']);
    expect(result).toMatchObject({ outcome: 'completed', summary: { stored: 2 } });
    expect((await cursor())!.indexKey).toBe('ik-0004');
  });

  it('стоимость прохода: ящик заново не читается — только новое после курсора', async () => {
    // Ящик с историей: 1000 событий уже выгружены прежними проходами.
    const feed = Array.from({ length: 1000 }, (_, i) => ev(i + 1));
    await run(fakeClient(feed).client, { ...FULL, maxEvents: 100_000, maxDownloads: 100_000 });

    // Тихие полчаса: новых событий нет — один запрос к ленте, ни одного скачивания.
    const quiet = fakeClient(feed);
    expect(await run(quiet.client)).toMatchObject({ outcome: 'completed', summary: { eventsSeen: 0 } });
    expect(quiet.calls.getNewEvents).toHaveBeenCalledTimes(1);
    expect(quiet.calls.getEntityContent).not.toHaveBeenCalled();
    expect(quiet.calls.getMessage).not.toHaveBeenCalled();

    // Обычные полчаса: 12 новых событий — страница с ними, пустая страница-конец
    // и скачивания только новых УПД.
    feed.push(...Array.from({ length: 12 }, (_, i) => ev(1001 + i)));
    const usual = fakeClient(feed);
    expect(await run(usual.client)).toMatchObject({ summary: { eventsSeen: 12, stored: 12 } });
    expect(usual.calls.getNewEvents).toHaveBeenCalledTimes(2);
    expect(usual.calls.getEntityContent).toHaveBeenCalledTimes(12);
  });

  it('журнал хранится 90 дней', async () => {
    await sql`INSERT INTO edo_export_runs (edo_account_id, scope, trigger, outcome, started_at, finished_at)
              VALUES (${accountId}, 'all', 'auto', 'completed', now() - interval '100 days', now() - interval '100 days'),
                     (${accountId}, 'all', 'auto', 'completed', now() - interval '30 days', now() - interval '30 days')`;

    await run(fakeClient([ev(1)]).client);

    const left = await runs();
    expect(left).toHaveLength(2);
    expect(left[0]!.startedAt.getTime()).toBeGreaterThan(Date.now() - 31 * 86_400_000);
  });

  it('обрыв посреди страницы — курсор на прошлой странице, повтор докачивает остальное', async () => {
    const feed = Array.from({ length: 150 }, (_, i) => ev(i + 1));
    const broken = fakeClient(feed, (id) =>
      id === 'ent-120' ? new DiadocTransient('обрыв', { endpoint: 'GetEntityContent' }) : updXml(id),
    );

    const failed = await run(broken.client);
    expect(failed).toMatchObject({ outcome: 'error' });
    expect((await cursor())!.indexKey).toBe('ik-0100');
    expect((await runs())[0]).toMatchObject({ outcome: 'error', indexKeyAfter: 'ik-0100', stored: 119 });

    const healthy = fakeClient(feed);
    const result = await run(healthy.client);
    expect(healthy.calls.getNewEvents.mock.calls[0]![0]).toMatchObject({ afterIndexKey: 'ik-0100' });
    expect(result).toMatchObject({ outcome: 'completed', summary: { stored: 31, alreadyStored: 19 } });
    expect((await cursor())!.indexKey).toBe('ik-0150');
    expect((await docs()).filter((d) => d.status === 'stored')).toHaveLength(150);
  });

  it('отсечка по времени — из курсора, а не из текущего EDO_EXPORT_SINCE', async () => {
    const since = new Date('2026-10-01T09:00:00Z');
    await db.insert(edoExportCursors).values({ edoAccountId: accountId, boxId: OUR_BOX, feedQuery: EXPORT_FEED_QUERY, since });
    const { client, calls } = fakeClient([ev(1)]);

    await run(client);

    expect(calls.getNewEvents.mock.calls[0]![0]).toMatchObject({ fromTimestamp: since });
    expect((await cursor())!.since).toEqual(since);
  });

  it('курсор от другого ящика — ошибка в журнале, ни одного запроса к ленте', async () => {
    await db.insert(edoExportCursors).values({
      edoAccountId: accountId,
      boxId: 'box-старый',
      feedQuery: EXPORT_FEED_QUERY,
      since: parseSince('2026-10-05'),
      indexKey: 'ik-0042',
    });
    const { client, calls } = fakeClient([ev(1)]);

    const result = await run(client);

    expect(result).toMatchObject({ outcome: 'error', cursorMismatch: true });
    expect(calls.getNewEvents).not.toHaveBeenCalled();
    expect(await cursor()).toMatchObject({ boxId: 'box-старый', indexKey: 'ik-0042' });
    const [journal] = await runs();
    expect(journal).toMatchObject({ outcome: 'error', indexKeyBefore: 'ik-0042', indexKeyAfter: 'ik-0042' });
    expect(journal!.error).toMatch(/явный сброс/);
    expect(await lease()).toBeNull();
  });

  it('предел событий срабатывает на границе страницы: страница дочитана, ключ сохранён', async () => {
    const feed = Array.from({ length: 150 }, (_, i) => ev(i + 1));
    const { client } = fakeClient(feed);

    const result = await run(client, { ...FULL, maxEvents: 50 });

    expect(result).toMatchObject({ outcome: 'truncated', summary: { eventsSeen: 100, stored: 100 } });
    expect((await cursor())!.indexKey).toBe('ik-0100');
    const [journal] = await runs();
    expect(journal).toMatchObject({ outcome: 'truncated', truncateReason: 'limit' });
    expect(journal!.feedCompletedAt).toBeNull();
  });

  it('лиз перехвачен — ключ не пишется, проход остановлен', async () => {
    const feed = [ev(1), ev(2), ev(3)];
    const { client } = fakeClient(feed, (id) => updXml(id), {
      onDownload: async (n) => {
        if (n === 2) {
          await db.update(edoAccounts).set({ pollLeaseToken: randomUUID() }).where(eq(edoAccounts.id, accountId));
        }
      },
    });

    const result = await run(client);

    expect(result).toMatchObject({ outcome: 'stopped' });
    expect((await cursor())!.indexKey).toBeNull();
  });

  it('лиз истёк к концу страницы — ключ не пишется, хотя токен ещё наш', async () => {
    const feed = [ev(1), ev(2)];
    const { client } = fakeClient(feed, (id) => updXml(id), {
      // После последнего скачивания продления до записи ключа уже не будет.
      onDownload: async (n) => {
        if (n === 2) {
          await db
            .update(edoAccounts)
            .set({ pollLeaseUntil: drSql`now() - interval '1 second'` })
            .where(eq(edoAccounts.id, accountId));
        }
      },
    });

    const result = await run(client);

    expect(result).toMatchObject({ outcome: 'stopped' });
    expect((await cursor())!.indexKey).toBeNull();
    expect((await docs()).filter((d) => d.status === 'stored')).toHaveLength(2);
  });

  it('лента отдаёт ту же страницу — ошибка, курсор на последней дочитанной', async () => {
    const { client } = fakeClient([ev(1), ev(2)], (id) => updXml(id), { ignoreCursor: true });

    const result = await run(client);

    expect(result).toMatchObject({ outcome: 'error' });
    expect(result).toHaveProperty('error', expect.stringMatching(/не сдвинулась/));
    expect((await cursor())!.indexKey).toBe('ik-0002');
  });

  it('перепись: без скачиваний, без дублей, мимо курсора и не упираясь в предел автопрохода', async () => {
    const feed = Array.from({ length: 5100 }, (_, i) => ev(i + 1, { scan: (i + 1) % 1000 === 0 }));
    const census: ExportRunMode = { scope: 'census', trigger: 'script', since: parseSince('2026-10-01'), maxEvents: 100_000 };
    const first = fakeClient(feed);

    const result = await run(first.client, census);

    expect(result).toMatchObject({ outcome: 'completed', summary: { eventsSeen: 5100, census: 5, stored: 0 } });
    expect(first.calls.getEntityContent).not.toHaveBeenCalled();
    expect(await cursor()).toBeNull();
    const rows = await db
      .select()
      .from(edoExportCensus)
      .where(eq(edoExportCensus.edoAccountId, accountId))
      .orderBy(asc(edoExportCensus.entityId));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      category: 'scan',
      documentType: 'Nonformalized',
      fileName: 'УПД ТК-1000.pdf',
      contentSize: 2000,
      counteragentBoxId: THEIR_BOX,
      fromTitle: 'ООО «ТПК ПромАэроТехника»',
      messageHasUtd: false,
    });

    const again = await run(fakeClient(feed).client, census);
    expect(again).toMatchObject({ summary: { census: 0 } });
    expect((await runs()).map((r) => r.scope)).toEqual(['census', 'census']);
  });

  it('повтор: созревший сбой выгружается, пятая неудача — окончательно, исчезнувший — закрыт', async () => {
    const feed = [ev(1), ev(2), ev(3)];
    const flaky = new Error('HTTP 500 от хранилища Диадока');
    await run(fakeClient(feed, () => flaky).client);
    expect((await docs()).map((d) => [d.attempts, d.nextRetryAt !== null])).toEqual([
      [1, true],
      [1, true],
      [1, true],
    ]);

    // ent-1 — созрел и вылечился; ent-2 — четыре неудачи позади; ent-3 — сообщение исчезло.
    const due = drSql`now() - interval '1 minute'`;
    await db.update(edoExportDocuments).set({ nextRetryAt: due }).where(eq(edoExportDocuments.edoAccountId, accountId));
    await db
      .update(edoExportDocuments)
      .set({ attempts: 4 })
      .where(and(eq(edoExportDocuments.edoAccountId, accountId), eq(edoExportDocuments.entityId, 'ent-2')));
    const { client, calls } = fakeClient(
      [ev(1), ev(2)],
      (id) => (id === 'ent-2' ? flaky : updXml(id)),
    );

    const result = await run(client);

    expect(result).toMatchObject({ retry: { picked: 3, stored: 1, failed: 1, closed: 1 } });
    expect(calls.getMessage).toHaveBeenCalledTimes(3);
    const byEntity = Object.fromEntries((await docs()).map((d) => [d.entityId, d]));
    expect(byEntity['ent-1']).toMatchObject({ status: 'stored', nextRetryAt: null });
    expect(byEntity['ent-2']).toMatchObject({ status: 'failed', attempts: 5, nextRetryAt: null });
    expect(byEntity['ent-3']).toMatchObject({ status: 'failed', nextRetryAt: null });
    expect(byEntity['ent-3']!.lastError).toMatch(/исчезло/);
    expect((await runs()).at(-1)).toMatchObject({ retried: 3 });
  });

  it('зависший «running» от убитого процесса закрывается следующим проходом', async () => {
    await db.insert(edoExportRuns).values({ edoAccountId: accountId, scope: 'all', trigger: 'auto' });

    await run(fakeClient([ev(1)]).client);

    const [stale, fresh] = await runs();
    expect(stale).toMatchObject({ outcome: 'error' });
    expect(stale!.error).toMatch(/прервано/);
    expect(fresh).toMatchObject({ outcome: 'completed' });
  });

  it('остановка процесса: проход «stopped», лиз освобождён', async () => {
    const abort = new AbortController();
    const feed = [ev(1), ev(2), ev(3)];
    const { client, calls } = fakeClient(feed, (id) => updXml(id), {
      onDownload: async (n) => {
        if (n === 1) abort.abort();
      },
    });

    const result = await run(client, FULL, { signal: abort.signal });

    expect(result).toMatchObject({ outcome: 'stopped' });
    expect(calls.getEntityContent).toHaveBeenCalledTimes(1);
    expect(await lease()).toBeNull();
    expect((await runs())[0]).toMatchObject({ outcome: 'stopped' });
  });

  it('выгрузка по списку пишет журнал «list» и курсор не трогает', async () => {
    const result = await run(fakeClient([ev(1)]).client, {
      scope: 'list',
      trigger: 'script',
      since: parseSince('2026-10-01'),
      suppliers: new Map([[SELLER, 'Из списка']]),
    });

    expect(result).toMatchObject({ outcome: 'completed', summary: { stored: 1, census: 0 } });
    expect(await cursor()).toBeNull();
    expect((await runs()).map((r) => r.scope)).toEqual(['list']);
  });

  it('учётка занята — проход не начинается и журнал не пишется', async () => {
    await db
      .update(edoAccounts)
      .set({ pollLeaseToken: randomUUID(), pollLeaseUntil: drSql`now() + interval '10 minutes'` })
      .where(eq(edoAccounts.id, accountId));
    const { client, calls } = fakeClient([ev(1)]);

    expect(await run(client)).toEqual({ skipped: 'lease_taken' });
    expect(calls.getNewEvents).not.toHaveBeenCalled();
    expect(await runs()).toEqual([]);
  });

  it('три прохода подряд без сдвига курсора — «застрял»', async () => {
    const broken = () => fakeClient([ev(1)], () => new DiadocTransient('обрыв', { endpoint: 'GetEntityContent' }));
    await run(broken().client);
    await run(broken().client);
    expect(await isExportStuck(db, accountId)).toBe(false);
    await run(broken().client);
    expect(await isExportStuck(db, accountId)).toBe(true);
    await run(fakeClient([ev(1)]).client);
    expect(await isExportStuck(db, accountId)).toBe(false);
  });
});
