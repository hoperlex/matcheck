/**
 * Выгрузка реестра УПД из СБИС (sbis-export-runner) — на настоящем PostgreSQL
 * с поддельным клиентом СБИС.
 *
 * Обещания, которые проверяются базой:
 *   - в реестр попадают только входящие УПД события «Получение», с редакцией,
 *     ИдФайл и отпечатком состава; повторный проход ничего не перекачивает;
 *   - пустая страница не объявляет ленту дочитанной: ставит подтверждение, а
 *     feed_completed_at = ДатаВремяПо подтверждённого запроса, не now();
 *   - любой следующий проход начинает с незакрытого подтверждения;
 *   - ошибка курсора — один повтор по времени события, повторная — ошибка
 *     прохода без сдвига курсора;
 *   - 403 на файле — свежая ссылка той же редакции; снова 403 — стоп, курсор
 *     на прежней странице; частичный ответ ПрочитатьДокумент догружается
 *     лентой документа; удалённый документ — окончательный сбой;
 *   - повтор сбоев идёт через свежую ссылку; лиз и отмена останавливают проход.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ключи шифрования для теста — до импорта модулей (loadEnv кэширует окружение).
process.env.APP_FIELD_ENCRYPTION_KEYS ??= '{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}';
process.env.APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ??= 'v1';

const schema = await import('../../src/db/schema.js');
const { edoAccounts, edoExportCursors, edoExportDocuments, edoExportRuns } = schema;
const { buildAad, encryptToString } = await import('../../src/domain/auth/crypto.js');
const { SbisAborted, SbisAccessDenied, SbisRpcError } = await import('../../src/domain/edo/sbis/sbis.http.js');
const { SbisDocumentSchema, formatSbisDateTime } = await import('../../src/domain/edo/sbis/sbis.types.js');
const runner = await import('../../src/domain/jobs/sbis-export-runner.js');
const { runSbisExportPass, parseCursorState } = runner;
import type { Db } from '../../src/db/client.js';
import type { SbisClient } from '../../src/domain/edo/sbis/sbis.client.js';
import type { SbisDocument } from '../../src/domain/edo/sbis/sbis.types.js';
import type { SbisExportDeps, SbisExportMode } from '../../src/domain/jobs/sbis-export-runner.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const ORG_REF = 'legal:7736255508:774550001:';
const NOW = new Date('2026-10-22T10:00:00Z');
const MODE: SbisExportMode = { trigger: 'auto', maxEvents: 5000, maxDownloads: 500 };
const SESSION = { mode: 'key' as const, headers: { 'X-SBISAccessToken': 't' }, secrets: ['t'] };

function xml(number: string, seller = '7705794997'): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_${number}" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="${number}" ДатаДок="18.10.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="АО Продавец" ИННЮЛ="${seller}" КПП="770501001"/></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО СУ-10" ИННЮЛ="7736255508" КПП="774550001"/></ИдСв></СвПокуп>
    </СвСчФакт>
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

function zipOf(name: string, data: Buffer): Buffer {
  const body = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + body.length, 16);
  return Buffer.concat([local, n, body, central, n, end]);
}

type DocSpec = {
  id: string;
  eventId?: string;
  eventTime?: string;
  eventName?: string;
  type?: string;
  attId?: string;
  link?: string;
  revisionId?: string;
};

function doc(s: DocSpec): SbisDocument {
  return SbisDocumentSchema.parse({
    Идентификатор: s.id,
    Направление: 'Входящий',
    Номер: `N-${s.id}`,
    Дата: '18.10.2026',
    Контрагент: { СвЮЛ: { ИНН: '7705794997', Название: 'АО Продавец' } },
    Редакция: [{ Идентификатор: s.revisionId ?? `rev-${s.id}` }],
    Событие: [
      {
        Идентификатор: s.eventId ?? `ev-${s.id}`,
        Название: s.eventName ?? 'Получение',
        ДатаВремя: s.eventTime ?? '20.10.2026 12.00.00.123',
        Вложение: [
          {
            Идентификатор: s.attId ?? `att-${s.id}`,
            Тип: s.type ?? 'УпдСчфДоп',
            Направление: 'Входящий',
            Служебный: 'Нет',
            ВерсияФормата: '5.03',
            Файл: { Имя: 'f.xml', Ссылка: s.link ?? `https://disk.sbis.ru/${s.id}` },
          },
        ],
      },
    ],
  });
}

type Fake = {
  pages?: (SbisDocument[] | Error)[];
  files?: Record<string, Buffer | Error | ((n: number) => Promise<Buffer>)>;
  read?: (q: { documentId: string; revisionId?: string | null }) => SbisDocument | Error;
  docChanges?: (documentId: string) => SbisDocument[];
};

function fakeClient(cfg: Fake) {
  const pages = [...(cfg.pages ?? [])];
  const calls = {
    listChanges: [] as { cursor: unknown; until: Date; since: Date }[],
    readDocument: [] as { documentId: string; revisionId?: string | null }[],
    listDocumentChanges: [] as string[],
    downloads: [] as string[],
  };
  let downloads = 0;
  const client: SbisClient = {
    listOurOrganizations: async () => ({ orgs: [], complete: true, pages: 1, stopReason: 'end' }),
    listChanges: async (q) => {
      calls.listChanges.push({ cursor: q.cursor ? { ...q.cursor } : null, until: q.until, since: q.since });
      const next = pages.shift() ?? [];
      if (next instanceof Error) throw next;
      return { documents: next, hasMore: null, receivedAt: NOW };
    },
    readDocument: async (q) => {
      calls.readDocument.push(q);
      const res = cfg.read?.(q) ?? new Error('ПрочитатьДокумент не настроен');
      if (res instanceof Error) throw res;
      return res;
    },
    listDocumentChanges: async (q) => {
      calls.listDocumentChanges.push(q.documentId);
      return cfg.docChanges?.(q.documentId) ?? [];
    },
    downloadFile: async (link) => {
      calls.downloads.push(link);
      downloads += 1;
      const file = cfg.files?.[link];
      if (!file) throw new Error(`нет файла ${link}`);
      if (file instanceof Error) throw file;
      const bytes = typeof file === 'function' ? await file(downloads) : file;
      return { bytes, zip: bytes[0] === 0x50 && bytes[1] === 0x4b };
    },
  };
  return { client, calls };
}

const denied = () => new SbisAccessDenied('disk.sbis.ru/x');
const cursorError = () =>
  new SbisRpcError('СБИС.СписокИзменений', '-32000', '1FA000000000', 'Не найдено событие с идентификатором ev-x');

suite('выгрузка реестра УПД из СБИС (реальный PostgreSQL)', { timeout: 60_000 }, () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const created: string[] = [];
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  function deps(client: SbisClient, extra: Partial<SbisExportDeps> = {}): SbisExportDeps {
    return {
      db,
      log,
      owner: randomUUID(),
      put: vi.fn(async () => {}),
      login: async () => SESSION,
      createClient: () => client,
      scheduleConfirm: vi.fn(async () => {}),
      now: () => NOW,
      ...extra,
    };
  }

  async function cursorState() {
    const [row] = await db.select().from(edoExportCursors).where(eq(edoExportCursors.edoAccountId, accountId));
    return row ? parseCursorState(row.indexKey) : null;
  }
  async function rows() {
    return db.select().from(edoExportDocuments).where(eq(edoExportDocuments.edoAccountId, accountId));
  }
  async function lastRun() {
    const all = await db.select().from(edoExportRuns).where(eq(edoExportRuns.edoAccountId, accountId));
    return all.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).at(-1)!;
  }
  async function seedCursor(state: object) {
    await db.insert(edoExportCursors).values({
      edoAccountId: accountId,
      boxId: ORG_REF,
      feedQuery: runner.SBIS_FEED_QUERY,
      since: new Date('2026-08-31T21:00:00Z'),
      indexKey: JSON.stringify({ v: 1, eventId: null, eventTime: null, documentId: null, revisionId: null, confirm: null, verifiedUntil: null, ...state }),
    });
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
  });

  afterAll(async () => {
    if (created.length) await db.delete(edoAccounts).where(inArray(edoAccounts.id, created));
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    accountId = randomUUID();
    created.push(accountId);
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `СБИС ${accountId.slice(0, 8)}`,
      provider: 'sbis',
      authMode: 'sbis_service_key',
      credentialsEncrypted: encryptToString(
        JSON.stringify({ authMode: 'sbis_service_key', appClientId: 'app-1', appSecret: 'sec-1', secretKey: 'key-1' }),
        buildAad('edo_accounts', accountId),
      ),
      boxId: ORG_REF,
    });
  });

  it('первый проход: только входящие УПД «Получение», строки с редакцией и признаками копий, пустая страница ждёт подтверждения', async () => {
    const files = { 'https://disk.sbis.ru/d1': xml('101'), 'https://disk.sbis.ru/d3': xml('103') };
    const { client, calls } = fakeClient({
      pages: [
        [doc({ id: 'd1' }), doc({ id: 'd2', type: 'УпдСчфДопПокуп' }), doc({ id: 'd2b', eventName: 'Утверждение' })],
        [doc({ id: 'd3', eventTime: '20.10.2026 13.00.00' })],
      ],
      files,
    });
    const d = deps(client);
    const result = await runSbisExportPass(d, accountId, MODE);

    expect(result).toMatchObject({ outcome: 'completed', error: null, summary: { stored: 2, candidates: 2, confirmPending: true } });
    expect(calls.listChanges[0]!.cursor).toBeNull();
    expect(calls.listChanges[0]!.since.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(calls.listChanges[1]!.cursor).toMatchObject({ eventId: 'ev-d2b', documentId: 'd2b', revisionId: 'rev-d2b' });
    const state = await cursorState();
    expect(state).toMatchObject({ eventId: 'ev-d3', eventTime: '20.10.2026 13.00.00', confirm: { until: formatSbisDateTime(NOW) } });
    expect(d.scheduleConfirm).toHaveBeenCalledWith(accountId);
    const run = await lastRun();
    expect(run).toMatchObject({ outcome: 'completed', stored: 2, feedCompletedAt: null });
    const stored = (await rows()).sort((a, b) => a.messageId.localeCompare(b.messageId));
    expect(stored.map((r) => [r.messageId, r.entityId, r.status, r.documentType, r.providerRevisionId, r.counteragentBoxId])).toEqual([
      ['d1', 'att-d1', 'stored', 'УпдСчфДоп', 'rev-d1', null],
      ['d3', 'att-d3', 'stored', 'УпдСчфДоп', 'rev-d3', null],
    ]);
    expect(stored.every((r) => r.fileId?.startsWith('ON_NSCHFDOPPR_') && r.contentKey?.length === 64)).toBe(true);
    expect(stored[0]!.receivedAt?.toISOString()).toBe('2026-10-20T09:00:00.123Z');
  });

  it('подтверждение: тот же запрос пуст → лента проверена до confirm.until (не now), затем новый интервал', async () => {
    const confirmUntil = '22.10.2026 12.00.00';
    await seedCursor({ eventId: 'ev-9', eventTime: '20.10.2026 12.00.00', documentId: 'd9', revisionId: 'r9', confirm: { until: confirmUntil } });
    const later = new Date('2026-10-22T10:30:00Z');
    const { client, calls } = fakeClient({ pages: [[], []] });
    const result = await runSbisExportPass(deps(client, { now: () => later }), accountId, MODE);

    expect(result).toMatchObject({ outcome: 'completed', summary: { feedConfirmed: true, confirmPending: true } });
    expect(formatSbisDateTime(calls.listChanges[0]!.until)).toBe(confirmUntil);
    expect(calls.listChanges[0]!.cursor).toMatchObject({ eventId: 'ev-9' });
    expect(formatSbisDateTime(calls.listChanges[1]!.until)).toBe(formatSbisDateTime(later));
    expect((await lastRun()).feedCompletedAt?.toISOString()).toBe('2026-10-22T09:00:00.000Z');
    expect(await cursorState()).toMatchObject({ verifiedUntil: '2026-10-22T09:00:00.000Z', confirm: { until: formatSbisDateTime(later) } });
  });

  it('подтверждение принесло события — они обрабатываются, подтверждение снимается', async () => {
    await seedCursor({ eventId: 'ev-9', eventTime: '20.10.2026 12.00.00', confirm: { until: '22.10.2026 12.00.00' } });
    const { client } = fakeClient({ pages: [[doc({ id: 'd5' })], []], files: { 'https://disk.sbis.ru/d5': xml('105') } });
    const result = await runSbisExportPass(deps(client), accountId, MODE);
    expect(result).toMatchObject({ outcome: 'completed', summary: { stored: 1, feedConfirmed: false } });
    expect((await lastRun()).feedCompletedAt).toBeNull();
  });

  it('без событий и с проверенной границей — следующий интервал начинается с неё', async () => {
    await seedCursor({ verifiedUntil: '2026-10-21T09:00:00.000Z' });
    const { client, calls } = fakeClient({ pages: [[]] });
    await runSbisExportPass(deps(client), accountId, MODE);
    expect(calls.listChanges[0]!.cursor).toBeNull();
    expect(calls.listChanges[0]!.since.toISOString()).toBe('2026-10-21T09:00:00.000Z');
  });

  it('повторный проход не качает уже сохранённое; та же УПД в новом «Получении» — только счёт', async () => {
    const first = fakeClient({ pages: [[doc({ id: 'd1' })], []], files: { 'https://disk.sbis.ru/d1': xml('101') } });
    await runSbisExportPass(deps(first.client), accountId, MODE);
    await db.update(edoExportCursors).set({ indexKey: JSON.stringify({ ...(await cursorState()), confirm: null }) }).where(eq(edoExportCursors.edoAccountId, accountId));
    const again = fakeClient({ pages: [[doc({ id: 'd1', eventId: 'ev-d1-again', eventTime: '21.10.2026 09.00.00' })], []] });
    const result = await runSbisExportPass(deps(again.client), accountId, MODE);
    expect(again.calls.downloads).toEqual([]);
    expect(result).toMatchObject({ summary: { alreadyKnown: 1, revisionsIgnored: 1, stored: 0 } });
    expect(await rows()).toHaveLength(1);
  });

  it('ошибка курсора — один повтор по времени события; повторная — ошибка, курсор не двигается', async () => {
    await seedCursor({ eventId: 'ev-9', eventTime: '20.10.2026 12.00.00', documentId: 'd9' });
    const ok = fakeClient({ pages: [cursorError(), [doc({ id: 'd6' })], []], files: { 'https://disk.sbis.ru/d6': xml('106') } });
    const r1 = await runSbisExportPass(deps(ok.client), accountId, MODE);
    expect(r1).toMatchObject({ outcome: 'completed', summary: { cursorRecoveries: 1, stored: 1 } });
    expect(ok.calls.listChanges[1]!.cursor).toEqual({ eventId: null, eventTime: '20.10.2026 12.00.00', documentId: null, revisionId: null });

    const before = (await cursorState())!;
    await db.update(edoExportCursors).set({ indexKey: JSON.stringify({ ...before, confirm: null }) }).where(eq(edoExportCursors.edoAccountId, accountId));
    const bad = fakeClient({ pages: [cursorError(), cursorError()] });
    const r2 = await runSbisExportPass(deps(bad.client), accountId, MODE);
    expect(r2).toMatchObject({ outcome: 'error' });
    expect((await cursorState())!.eventId).toBe(before.eventId);
  });

  it('403 на файле — свежая ссылка той же редакции; снова 403 — стоп прохода, курсор на месте', async () => {
    const read = (link: string) => () =>
      SbisDocumentSchema.parse({ Идентификатор: 'd7', Вложение: [{ Идентификатор: 'att-d7', Файл: { Ссылка: link } }] });
    const ok = fakeClient({
      pages: [[doc({ id: 'd7' })], []],
      files: { 'https://disk.sbis.ru/d7': denied(), 'https://disk.sbis.ru/fresh': xml('107') },
      read: read('https://disk.sbis.ru/fresh'),
    });
    const r1 = await runSbisExportPass(deps(ok.client), accountId, MODE);
    expect(r1).toMatchObject({ outcome: 'completed', summary: { stored: 1, refreshedLinks: 1 } });
    expect(ok.calls.readDocument).toEqual([{ documentId: 'd7', revisionId: 'rev-d7' }]);

    const accountB = randomUUID();
    created.push(accountB);
    await db.insert(edoAccounts).values({
      id: accountB,
      name: `СБИС B ${accountB.slice(0, 8)}`,
      provider: 'sbis',
      authMode: 'sbis_service_key',
      credentialsEncrypted: encryptToString(
        JSON.stringify({ authMode: 'sbis_service_key', appClientId: 'a', appSecret: 'b', secretKey: 'c' }),
        buildAad('edo_accounts', accountB),
      ),
      boxId: ORG_REF,
    });
    const bad = fakeClient({
      pages: [[doc({ id: 'd8' })]],
      files: { 'https://disk.sbis.ru/d8': denied(), 'https://disk.sbis.ru/fresh8': denied() },
      read: () => SbisDocumentSchema.parse({ Идентификатор: 'd8', Вложение: [{ Идентификатор: 'att-d8', Файл: { Ссылка: 'https://disk.sbis.ru/fresh8' } }] }),
    });
    const r2 = await runSbisExportPass(deps(bad.client), accountB, MODE);
    expect(r2).toMatchObject({ outcome: 'error' });
    expect(String((r2 as { error: string }).error)).toContain('свежей ссылке');
    const [cursorB] = await db.select().from(edoExportCursors).where(eq(edoExportCursors.edoAccountId, accountB));
    expect(cursorB!.indexKey).toBeNull();
    expect(await db.select().from(edoExportDocuments).where(eq(edoExportDocuments.edoAccountId, accountB))).toEqual([]);
  });

  it('частичный ответ ПрочитатьДокумент догружается лентой документа; удалённый документ — окончательный сбой', async () => {
    const { client, calls } = fakeClient({
      pages: [[doc({ id: 'p1' }), doc({ id: 'del1' })], []],
      files: { 'https://disk.sbis.ru/p1': denied(), 'https://disk.sbis.ru/p1-fresh': xml('201'), 'https://disk.sbis.ru/del1': denied() },
      read: (q) =>
        q.documentId === 'p1'
          ? SbisDocumentSchema.parse({ Идентификатор: 'p1', ЧастичныеДанные: 'Да', Вложение: [] })
          : SbisDocumentSchema.parse({ Идентификатор: 'del1', Удален: 'Да' }),
      docChanges: () => [
        SbisDocumentSchema.parse({
          Идентификатор: 'p1',
          Событие: [{ Идентификатор: 'e', Название: 'Получение', Вложение: [{ Идентификатор: 'att-p1', Файл: { Ссылка: 'https://disk.sbis.ru/p1-fresh' } }] }],
        }),
      ],
    });
    const result = await runSbisExportPass(deps(client), accountId, MODE);
    expect(result).toMatchObject({ outcome: 'completed', summary: { stored: 1, failed: 1 } });
    expect(calls.listDocumentChanges).toEqual(['p1']);
    const byId = Object.fromEntries((await rows()).map((r) => [r.messageId, r]));
    expect(byId.p1).toMatchObject({ status: 'stored' });
    expect(byId.del1).toMatchObject({ status: 'failed', lastError: 'документ удалён в СБИС', nextRetryAt: null });
  });

  it('повтор сбоя по расписанию — через свежую ссылку той же редакции', async () => {
    await seedCursor({ eventId: 'ev-9', eventTime: '20.10.2026 12.00.00' });
    await db.insert(edoExportDocuments).values({
      edoAccountId: accountId,
      messageId: 'r1',
      entityId: 'att-r1',
      documentType: 'УпдСчфДоп',
      status: 'failed',
      lastError: 'скачивание: сеть',
      attempts: 1,
      nextRetryAt: new Date(Date.now() - 60_000),
      providerRevisionId: 'rev-r1',
      receivedAt: new Date('2026-10-20T09:00:00Z'),
    });
    const { client, calls } = fakeClient({
      pages: [[]],
      files: { 'https://disk.sbis.ru/r1': xml('301') },
      read: () => SbisDocumentSchema.parse({ Идентификатор: 'r1', Вложение: [{ Идентификатор: 'att-r1', Файл: { Ссылка: 'https://disk.sbis.ru/r1' } }] }),
    });
    const result = await runSbisExportPass(deps(client), accountId, MODE);
    expect(result).toMatchObject({ outcome: 'completed', retry: { picked: 1, stored: 1 } });
    expect(calls.readDocument).toEqual([{ documentId: 'r1', revisionId: 'rev-r1' }]);
    expect((await rows())[0]).toMatchObject({ status: 'stored', lastError: null });
  });

  it('zip со ссылки распаковывается; в хранилище — XML', async () => {
    const put = vi.fn(async () => {});
    const { client } = fakeClient({ pages: [[doc({ id: 'z1' })], []], files: { 'https://disk.sbis.ru/z1': zipOf('ON_Z.xml', xml('401')) } });
    await runSbisExportPass(deps(client, { put }), accountId, MODE);
    expect((await rows())[0]).toMatchObject({ status: 'stored', documentNumber: '401' });
    const body = (put.mock.calls[0] as unknown as [string, Buffer])[1];
    expect(body.subarray(0, 5).toString()).toBe('<?xml');
  });

  it('потеря лиза и отмена — stopped; пределы — truncated', async () => {
    const steal = fakeClient({
      pages: [[doc({ id: 'l1' }), doc({ id: 'l2' })]],
      files: {
        'https://disk.sbis.ru/l1': async () => {
          await db.update(edoAccounts).set({ pollLeaseToken: randomUUID() }).where(eq(edoAccounts.id, accountId));
          return xml('501');
        },
        'https://disk.sbis.ru/l2': xml('502'),
      },
    });
    expect(await runSbisExportPass(deps(steal.client), accountId, MODE)).toMatchObject({ outcome: 'stopped' });

    await db.update(edoAccounts).set({ pollLeaseToken: null, pollLeaseOwner: null, pollLeaseUntil: null }).where(eq(edoAccounts.id, accountId));
    const abort = fakeClient({ pages: [new SbisAborted()] });
    expect(await runSbisExportPass(deps(abort.client), accountId, MODE)).toMatchObject({ outcome: 'stopped' });

    const limited = fakeClient({ pages: [[doc({ id: 'm1' })], [doc({ id: 'm2' })]], files: { 'https://disk.sbis.ru/m1': xml('601') } });
    const r = await runSbisExportPass(deps(limited.client), accountId, { ...MODE, maxEvents: 1 });
    expect(r).toMatchObject({ outcome: 'truncated', summary: { truncateReason: 'limit', pages: 1 } });
    expect((await lastRun()).truncateReason).toBe('limit');
  });

  it('учётка не СБИС и без организации — пропуск без записей', async () => {
    const diadocId = randomUUID();
    const noOrgId = randomUUID();
    created.push(diadocId, noOrgId);
    await db.insert(edoAccounts).values([
      { id: diadocId, name: 'Диадок', credentialsEncrypted: '{}', boxId: 'box' },
      {
        id: noOrgId,
        name: 'СБИС без организации',
        provider: 'sbis',
        authMode: 'sbis_service_key',
        credentialsEncrypted: '{}',
      },
    ]);
    const { client } = fakeClient({});
    expect(await runSbisExportPass(deps(client), diadocId, MODE)).toEqual({ skipped: 'provider' });
    expect(await runSbisExportPass(deps(client), noOrgId, MODE)).toEqual({ skipped: 'no_box' });
    const runs = await db
      .select()
      .from(edoExportRuns)
      .where(and(inArray(edoExportRuns.edoAccountId, [diadocId, noOrgId])));
    expect(runs).toEqual([]);
  });
});
