/**
 * Проба СБИС на поддельном клиенте: все шаги проходят и считают то, что
 * должны. Проба запускается на бою с настоящими ключами, и упасть там на
 * опечатке — значит потратить вход из лимита и круг «запуск → отчёт».
 *
 * Отдельно закреплены правила, принятые после ревью плана:
 *   - пустая страница — не конец ленты: пауза и повтор с теми же параметрами;
 *   - «не найдено в Диадоке» — только при полном списке организаций, ленте до
 *     конца интервала и полном реестре Диадока;
 *   - образцы не отсекаются по дате события; 403 → свежая ссылка, иначе unknown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SbisSession } from '../src/domain/edo/sbis/sbis.auth.js';
import {
  createSbisClient,
  looksLikeZip,
  type SbisChangesPage,
  type SbisClient,
  type SbisOrgList,
  type SbisOrgRef,
} from '../src/domain/edo/sbis/sbis.client.js';
import type { DiadocCoverageRow } from '../src/domain/edo/sbis/diadoc-coverage.js';
import { SbisAttachmentSet, collectSbisAttachments, type SbisUniqueAttachment } from '../src/domain/edo/sbis/sbis.entities.js';
import {
  SbisAccessDenied,
  SbisAuthRejected,
  SbisGone,
  SbisRequestNotAllowed,
  SbisRpcError,
} from '../src/domain/edo/sbis/sbis.http.js';
import {
  downloadSample,
  pickSamples,
  runSbisProbe,
  scanFeed,
  type DiadocRegistryRow,
  type SbisProbeDeps,
  type SbisProbeOptions,
  type SbisProbeReport,
} from '../src/domain/edo/sbis/probe.js';
import { SbisDocumentSchema, SbisOrgSchema, type SbisDocument } from '../src/domain/edo/sbis/sbis.types.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const SINCE = new Date('2026-08-31T21:00:00Z');
const ORG: SbisOrgRef = { kind: 'legal', inn: '7736255508', kpp: '771501001', branch: null, name: 'СУ-10' };
const SESSION: SbisSession = { mode: 'key', headers: { 'X-SBISAccessToken': 'tok' }, secrets: ['tok'] };
const noSleep = async () => {};

type DocSpec = {
  id: string;
  eventId?: string;
  eventTime?: string;
  eventName?: string;
  seller?: string;
  number?: string;
  date?: string;
  attDirection?: string;
  type?: string;
  attId?: string;
  link?: string;
  revisionId?: string;
};

function sbisDoc(s: DocSpec): SbisDocument {
  return SbisDocumentSchema.parse({
    Идентификатор: s.id,
    Направление: 'Входящий',
    Номер: s.number ?? `N-${s.id}`,
    Дата: s.date ?? '17.10.2026',
    Контрагент: { СвЮЛ: { ИНН: s.seller ?? '5024000001', Название: `Продавец ${s.seller ?? '5024000001'}` } },
    Редакция: [{ Идентификатор: s.revisionId ?? `rev-${s.id}` }],
    Событие: [
      {
        Идентификатор: s.eventId ?? `ev-${s.id}`,
        Название: s.eventName ?? 'Получение',
        ДатаВремя: s.eventTime ?? '18.10.2026 12.00.00.123',
        Вложение: [
          {
            Идентификатор: s.attId ?? `att-${s.id}`,
            Тип: s.type ?? 'УпдСчфДоп',
            Направление: s.attDirection ?? 'Входящий',
            Служебный: 'Нет',
            ВерсияФормата: '5.03',
            Редакция: { Номер: '1' },
            Файл: { Имя: 'f.xml', Ссылка: s.link ?? `https://disk.sbis.ru/${s.id}` },
          },
        ],
      },
    ],
  });
}

const page = (docs: SbisDocument[], hasMore: boolean | null = null): SbisChangesPage => ({
  documents: docs,
  hasMore,
  receivedAt: NOW,
});

const orgRaw = SbisOrgSchema.parse({
  СвЮЛ: { ИНН: ORG.inn, КПП: ORG.kpp, Название: 'СУ-10' },
  ДокументооборотПодключен: 'Да',
});

type FakeCfg = {
  pages?: (SbisChangesPage | Error)[];
  orgs?: SbisOrgList;
  read?: (q: { documentId: string; revisionId?: string | null }) => Promise<SbisDocument>;
  files?: Record<string, Buffer | Error>;
};

function fakeClient(cfg: FakeCfg = {}) {
  const pages = [...(cfg.pages ?? [])];
  const calls = {
    listChanges: [] as { org: SbisOrgRef; cursor: unknown }[],
    readDocument: [] as { documentId: string; revisionId?: string | null }[],
    downloads: [] as string[],
  };
  const client: SbisClient = {
    listOurOrganizations: async () => cfg.orgs ?? { orgs: [orgRaw], complete: true, pages: 1, stopReason: 'end' },
    listChanges: async (q) => {
      calls.listChanges.push({ org: q.org, cursor: q.cursor ? { ...q.cursor } : null });
      const next = pages.shift() ?? page([]);
      if (next instanceof Error) throw next;
      return next;
    },
    readDocument: async (q) => {
      calls.readDocument.push(q);
      if (!cfg.read) throw new Error('ПрочитатьДокумент не настроен');
      return cfg.read(q);
    },
    downloadFile: async (link) => {
      calls.downloads.push(link);
      const file = cfg.files?.[link];
      if (!file) throw new SbisGone(404, 'disk.sbis.ru/x');
      if (file instanceof Error) throw file;
      return { bytes: file, zip: looksLikeZip(file) };
    },
  };
  return { client, calls };
}

const scanOpts = { since: SINCE, until: NOW, maxDocs: 3000, emptyWaitMs: 60_000 };

const cursorError = () =>
  new SbisRpcError('СБИС.СписокИзменений', '-32000', '1FA000000000', 'Не найдено событие с идентификатором ev-x');

describe('клиент: список организаций', () => {
  const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 0 }));
  const orgA = { СвЮЛ: { ИНН: '7736255508', КПП: '771501001' }, ДокументооборотПодключен: 'Да' };
  const orgB = { СвФЛ: { ИНН: '500100732259' }, ДокументооборотПодключен: 'Нет' };

  function clientWith(...results: unknown[]) {
    const fetchImpl = vi.fn(async () => rpc(results.shift()));
    return { client: createSbisClient({ session: SESSION, transport: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep } }), fetchImpl };
  }
  const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse(String((fetchImpl.mock.calls[i] as unknown as [URL, RequestInit])[1].body));

  it('постранично до ЕстьЕще=Нет; Навигация в фильтре, страницы с нуля', async () => {
    const { client, fetchImpl } = clientWith(
      { НашаОрганизация: [orgA], Навигация: { ЕстьЕще: 'Да' } },
      { НашаОрганизация: [orgB], Навигация: { ЕстьЕще: 'Нет' } },
    );
    const list = await client.listOurOrganizations();
    expect(list).toMatchObject({ complete: true, pages: 2, stopReason: 'end' });
    expect(list.orgs).toHaveLength(2);
    expect(bodyOf(fetchImpl, 0).params.Фильтр.Навигация).toEqual({ Страница: '0', РазмерСтраницы: '200' });
    expect(bodyOf(fetchImpl, 1).params.Фильтр.Навигация.Страница).toBe('1');
  });

  it('навигацию проигнорировали (та же страница) — список неполный', async () => {
    const { client } = clientWith(
      { НашаОрганизация: [orgA], Навигация: { ЕстьЕще: 'Да' } },
      { НашаОрганизация: [orgA], Навигация: { ЕстьЕще: 'Да' } },
    );
    expect(await client.listOurOrganizations()).toMatchObject({ complete: false, stopReason: 'repeated_page' });
  });

  it('упор в предел страниц — список неполный', async () => {
    const { client } = clientWith(
      { НашаОрганизация: [orgA], Навигация: { ЕстьЕще: 'Да' } },
      { НашаОрганизация: [orgB], Навигация: { ЕстьЕще: 'Да' } },
    );
    expect(await client.listOurOrganizations({ pageCap: 2 })).toMatchObject({ complete: false, stopReason: 'page_cap', pages: 2 });
  });

  it('лента: курсор, своя организация и пределы в фильтре', async () => {
    const { client, fetchImpl } = clientWith({ Документ: [], Навигация: { ЕстьЕще: 'Нет' } }, { Документ: [] }, { Документ: [] });
    const first = await client.listChanges({ org: ORG, since: SINCE, until: NOW, cursor: null, pageSize: 500 });
    expect(first).toMatchObject({ documents: [], hasMore: false });
    expect(bodyOf(fetchImpl, 0).params.Фильтр).toEqual({
      ДатаВремяС: '01.09.2026 00.00.00',
      ДатаВремяПо: '19.10.2026 15.00.00',
      НашаОрганизация: { СвЮЛ: { ИНН: '7736255508', КПП: '771501001' } },
      ПолныйСертификатЭП: 'Нет',
      Навигация: { РазмерСтраницы: '50' },
    });

    await client.listChanges({
      org: ORG,
      since: SINCE,
      until: NOW,
      cursor: { eventId: 'ev-9', eventTime: '18.10.2026 12.00.00.123', documentId: 'doc-9', revisionId: 'rev-9' },
    });
    expect(bodyOf(fetchImpl, 1).params.Фильтр).toMatchObject({
      ДатаВремяС: '18.10.2026 12.00.00.123',
      ИдентификаторСобытия: 'ev-9',
      ИдентификаторДокумента: 'doc-9',
      ИдентификаторРедакции: 'rev-9',
      НашаОрганизация: { СвЮЛ: { ИНН: '7736255508' } },
    });

    // Восстановление после ошибки курсора: только время.
    await client.listChanges({
      org: ORG,
      since: SINCE,
      until: NOW,
      cursor: { eventId: null, eventTime: '18.10.2026 12.00.00.123', documentId: null, revisionId: null },
    });
    const third = bodyOf(fetchImpl, 2).params.Фильтр;
    expect(third.ДатаВремяС).toBe('18.10.2026 12.00.00.123');
    expect(third).not.toHaveProperty('ИдентификаторСобытия');
  });
});

describe('обход ленты', () => {
  it('пусто → пауза → повтор с теми же параметрами → пусто: интервал просмотрен', async () => {
    const { client, calls } = fakeClient();
    const sleep = vi.fn(noSleep);
    const scan = await scanFeed(client, ORG, scanOpts, sleep);
    expect(scan.feed).toEqual({ state: 'interval_scanned' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(calls.listChanges).toEqual([
      { org: ORG, cursor: null },
      { org: ORG, cursor: null },
    ]);
  });

  it('курсор — последнее событие страницы; организация в каждом запросе', async () => {
    const { client, calls } = fakeClient({
      pages: [page([sbisDoc({ id: 'd1', eventTime: '18.10.2026 10.00.00' }), sbisDoc({ id: 'd2', eventTime: '18.10.2026 11.00.00.5' })])],
    });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.feed.state).toBe('interval_scanned');
    expect(calls.listChanges[1]!.cursor).toEqual({
      eventId: 'ev-d2',
      eventTime: '18.10.2026 11.00.00.5',
      documentId: 'd2',
      revisionId: 'rev-d2',
    });
    expect(calls.listChanges.every((c) => c.org === ORG)).toBe(true);
    expect(scan.stats).toMatchObject({ documents: 2, events: 2, upd: { byAttachment: 2, incomingReceipt: 2 } });
  });

  it('после паузы пришли события — обход продолжается, а не заканчивается', async () => {
    const { client } = fakeClient({ pages: [page([]), page([sbisDoc({ id: 'd1' })])] });
    const sleep = vi.fn(noSleep);
    const scan = await scanFeed(client, ORG, scanOpts, sleep);
    expect(scan.feed.state).toBe('interval_scanned');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(scan.stats).toMatchObject({ documents: 1, emptyWaits: 2 });
  });

  it('упор в --max-docs — лента оборвана', async () => {
    const { client } = fakeClient({ pages: [page([sbisDoc({ id: 'd1' }), sbisDoc({ id: 'd2' }), sbisDoc({ id: 'd3' })])] });
    const scan = await scanFeed(client, ORG, { ...scanOpts, maxDocs: 2 }, noSleep);
    expect(scan.feed).toEqual({ state: 'truncated', reason: 'max_docs' });
  });

  it('курсор не сдвинулся — лента оборвана, а не зациклена', async () => {
    const { client } = fakeClient({ pages: [page([sbisDoc({ id: 'd1' })]), page([sbisDoc({ id: 'd1' })])] });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.feed).toEqual({ state: 'truncated', reason: 'stuck_cursor' });
  });

  it('ошибка курсора — повтор по времени последнего события (справка), один раз на шаг', async () => {
    const { client, calls } = fakeClient({
      pages: [page([sbisDoc({ id: 'd1', eventTime: '18.10.2026 10.00.00' })]), cursorError(), page([sbisDoc({ id: 'd2' })])],
    });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.feed.state).toBe('interval_scanned');
    expect(calls.listChanges[2]!.cursor).toEqual({
      eventId: null,
      eventTime: '18.10.2026 10.00.00',
      documentId: null,
      revisionId: null,
    });
    expect(scan.stats).toMatchObject({ cursorRecoveries: 1, documents: 2 });
  });

  it('ошибка курсора и после восстановления — лента оборвана', async () => {
    const { client } = fakeClient({ pages: [page([sbisDoc({ id: 'd1' })]), cursorError(), cursorError()] });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.feed).toMatchObject({ state: 'truncated', reason: 'cursor_error' });
  });

  it('прочая ошибка — лента оборвана с текстом ошибки', async () => {
    const { client } = fakeClient({ pages: [new SbisGone(404, 'online.sbis.ru/service/')] });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.feed).toMatchObject({ state: 'truncated', reason: 'error' });
    expect((scan.feed as { error: string }).error).toContain('404');
  });

  it('повторы событий и шаги назад по времени считаются', async () => {
    const { client } = fakeClient({
      pages: [
        page([
          sbisDoc({ id: 'd1', eventId: 'e1', eventTime: '18.10.2026 12.00.00' }),
          sbisDoc({ id: 'd2', eventId: 'e2', eventTime: '18.10.2026 11.00.00' }),
          sbisDoc({ id: 'd1', eventId: 'e1', eventTime: '18.10.2026 12.00.00' }),
        ]),
      ],
    });
    const scan = await scanFeed(client, ORG, scanOpts, noSleep);
    expect(scan.stats).toMatchObject({ eventRepeats: 1, stepsBackInTime: 1, documents: 2 });
  });
});

const XML_503 = `<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_1" ВерсФорм="5.03" ВерсПрог="1С">
  <Документ КНД="1115131" Функция="СЧФДОП" ПоФактХЖ="Документ об отгрузке товаров" ДатаИнфПр="17.10.2026">
    <СвСчФакт НомерДок="УТ-15" ДатаДок="17.10.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО Бетон" ИННЮЛ="5024000001" КПП="502401001"/></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО СУ-10" ИННЮЛ="7736255508" КПП="771501001"/></ИдСв></СвПокуп>
      <ДенИзм КодОКВ="643" НаимОКВ="Российский рубль"/>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Бетон B25" ОКЕИ_Тов="113" НаимЕдИзм="м3" КолТов="10" ЦенаТов="6500.00"
               СтТовБезНДС="65000.00" НалСт="20%" СтТовУчНал="78000.00">
        <Акциз><БезАкциз>без акциза</БезАкциз></Акциз>
        <СумНал><СумНал>13000.00</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="1"/>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="65000.00" СтТовУчНалВсего="78000.00">
        <СумНалВсего><СумНал>13000.00</СумНал></СумНалВсего>
      </ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

const coverageOk: DiadocCoverageRow = {
  accountId: 'acc-1',
  accountName: 'СУ-10 Диадок',
  provider: 'diadoc',
  cursorSince: new Date('2026-08-01T00:00:00Z'),
  lastFullPassAt: new Date('2026-10-19T12:30:00Z'),
  failedInInterval: 0,
  failedUndated: 0,
};

const registry: DiadocRegistryRow[] = [
  { status: 'stored', document_number: 'УТ-15', document_date: '2026-10-17', supplier_inn: '5024000001', seller_inns: ['5024000001'] },
  { status: 'stored', document_number: 'А-216', document_date: '2026-10-17', supplier_inn: '5024000001', seller_inns: null },
  // Тот же номер и дата, но другой ИНН — не пара.
  { status: 'stored', document_number: 'N-300', document_date: '2026-10-17', supplier_inn: '7711111111', seller_inns: null },
];

/** Три входящих УПД «Получение» и одна исходящая. */
const feedDocs = () => [
  sbisDoc({ id: 'd1', number: 'УТ-15' }),
  sbisDoc({ id: 'd2', number: 'УТ-00216' }),
  sbisDoc({ id: 'd3', number: 'N-300', seller: '7700000000' }),
  sbisDoc({ id: 'd4', number: 'X-1', attDirection: 'Исходящий' }),
];

function newReport(): SbisProbeReport {
  return {
    startedAt: NOW.toISOString(),
    interval: { since: SINCE.toISOString(), until: NOW.toISOString() },
    requests: {},
    steps: {},
    errors: [],
    summary: [],
  };
}

type ReconcileStep = {
  considered: number;
  updTotal: number;
  receiptRuleUnconfirmed: boolean;
  foundInDiadoc: { exact: number; digitsOnly: number };
  notFoundInDiadoc: {
    blocked: boolean;
    reasons?: string[];
    title?: string;
    count?: number;
    samples?: { sellerInn: string | null; number: string | null }[];
  };
};

const probeOpts: SbisProbeOptions = { since: SINCE, until: NOW, maxDocs: 3000, sample: 0, emptyWaitMs: 60_000 };

async function runWith(cfg: FakeCfg, over: Partial<SbisProbeDeps> = {}, opts: Partial<SbisProbeOptions> = {}) {
  const fake = fakeClient(cfg);
  const loadRegistry = vi.fn(async () => registry);
  const deps: SbisProbeDeps = {
    login: async () => SESSION,
    createClient: () => fake.client,
    diadoc: { loadCoverage: async () => [coverageOk], loadRegistry },
    sleep: noSleep,
    now: () => NOW,
    ...over,
  };
  const report = newReport();
  await runSbisProbe(deps, { ...probeOpts, ...opts }, report);
  return { report, fake, loadRegistry };
}

describe('проба целиком', () => {
  it('вход не прошёл — отчёт с причиной, дальше не идёт', async () => {
    const createClient = vi.fn();
    const report = newReport();
    await runSbisProbe(
      {
        login: async () => {
          throw new SbisAuthRejected('Приложение "***" не найдено!');
        },
        createClient,
      },
      probeOpts,
      report,
    );
    expect(report.errors[0]).toMatchObject({ step: 'login' });
    expect(report.summary.join('\n')).toContain('не прошёл');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('сверка: только входящие «Получение»; найдено точно и по цифрам; другой ИНН — не пара', async () => {
    const { report, loadRegistry } = await runWith({ pages: [page(feedDocs())] });
    expect(loadRegistry).toHaveBeenCalledWith(['5024000001', '7700000000']);
    const r = report.steps.reconcile as ReconcileStep;
    expect(r.considered).toBe(3);
    expect(r.foundInDiadoc).toMatchObject({ exact: 1, digitsOnly: 1 });
    expect(r.notFoundInDiadoc).toMatchObject({
      blocked: false,
      title: 'не найдено в проверенном реестре Диадока по предварительным признакам',
      count: 1,
    });
    expect(r.notFoundInDiadoc.samples?.[0]).toMatchObject({ sellerInn: '7700000000', number: 'N-300' });
    expect(report.errors).toEqual([]);
  });

  it('список организаций неполный — вывода «не найдено» нет', async () => {
    const { report } = await runWith({
      pages: [page(feedDocs())],
      orgs: { orgs: [orgRaw], complete: false, pages: 50, stopReason: 'page_cap' },
    });
    const r = report.steps.reconcile as ReconcileStep;
    expect(r.notFoundInDiadoc).toMatchObject({ blocked: true });
    expect(r.notFoundInDiadoc.reasons?.join('; ')).toContain('список организаций СБИС неполный');
    // Найденное в Диадоке показывается всегда.
    expect(r.foundInDiadoc.exact).toBe(1);
  });

  it('реестр Диадока не полон за интервал — вывода «не найдено» нет', async () => {
    const { report } = await runWith(
      { pages: [page(feedDocs())] },
      { diadoc: { loadCoverage: async () => [{ ...coverageOk, lastFullPassAt: null }], loadRegistry: async () => registry } },
    );
    const r = report.steps.reconcile as ReconcileStep;
    expect(r.notFoundInDiadoc.blocked).toBe(true);
    expect(r.notFoundInDiadoc.reasons?.join('; ')).toContain('нет ни одного полного прохода');
  });

  it('лента оборвана — вывода «не найдено» нет', async () => {
    const { report } = await runWith({ pages: [page(feedDocs())] }, {}, { maxDocs: 1 });
    const r = report.steps.reconcile as ReconcileStep;
    expect(r.notFoundInDiadoc.blocked).toBe(true);
    expect(r.notFoundInDiadoc.reasons?.join('; ')).toContain('ни одна лента СБИС не просмотрена до конца');
  });

  it('УПД есть, но ни одной в «Получении» — правило помечено как не подтверждённое', async () => {
    const { report } = await runWith({ pages: [page([sbisDoc({ id: 'd1', eventName: 'Утверждение' })])] });
    const r = report.steps.reconcile as ReconcileStep;
    expect(r).toMatchObject({ considered: 0, updTotal: 1, receiptRuleUnconfirmed: true });
    expect(report.summary.join('\n')).toContain('правило на данных не подтверждено');
  });

  it('упавший шаг не теряет предыдущие и не останавливает следующие', async () => {
    const { report } = await runWith(
      { pages: [page([sbisDoc({ id: 'd1', link: 'https://disk.sbis.ru/ok' })])], files: { 'https://disk.sbis.ru/ok': Buffer.from(XML_503) } },
      {
        diadoc: {
          loadCoverage: async () => {
            throw new Error('нет доступа к БД');
          },
          loadRegistry: async () => registry,
        },
      },
      { sample: 1 },
    );
    expect(report.errors.map((e) => e.step)).toEqual(['reconcile']);
    expect(report.steps.organizations).toBeTruthy();
    expect(report.steps[`feed ${ORG.inn}/${ORG.kpp}`]).toBeTruthy();
    expect(report.steps.samples).toBeTruthy();
  });

  it('образцы: старое событие не отсекается; XML разбирается; 403 → свежая ссылка; zip помечается', async () => {
    const save = vi.fn(async (name: string) => `/out/${name}`);
    const { report, fake } = await runWith(
      {
        pages: [
          page([
            sbisDoc({ id: 'old', eventTime: '01.09.2026 10.00.00', link: 'https://disk.sbis.ru/old', seller: '5024000001' }),
            sbisDoc({ id: 'new', link: 'https://disk.sbis.ru/new', seller: '7700000000' }),
          ]),
        ],
        files: {
          'https://disk.sbis.ru/old': Buffer.from(XML_503),
          'https://disk.sbis.ru/new': new SbisAccessDenied('disk.sbis.ru/new'),
          'https://disk.sbis.ru/fresh': ZIP,
        },
        read: async () =>
          SbisDocumentSchema.parse({
            Идентификатор: 'new',
            Вложение: [{ Идентификатор: 'att-new', Редакция: { Номер: '1' }, Файл: { Ссылка: 'https://disk.sbis.ru/fresh' } }],
          }),
      },
      { saveSample: save },
      { sample: 5 },
    );
    const s = report.steps.samples as { samples: Record<string, unknown>[]; outcomes: Record<string, number> };
    expect(s.samples).toHaveLength(2);
    const old = s.samples.find((x) => x.key === 'old/att-old')!;
    expect(old).toMatchObject({ download: { outcome: 'ok' }, kind: 'xml', eventAgeDays: 48 });
    expect(old.parse).toMatchObject({ number: 'УТ-15', sellerInn: '5024000001', items: 1, assessment: { ok: true } });
    const fresh = s.samples.find((x) => x.key === 'new/att-new')!;
    expect(fresh).toMatchObject({ download: { outcome: 'refreshed_ok', variant: 'by_revision' }, kind: 'zip' });
    expect(fresh.parse).toMatchObject({ skipped: expect.any(String) });
    expect(fake.calls.readDocument).toEqual([{ documentId: 'new', revisionId: 'rev-new' }]);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

function uniqueOf(docs: SbisDocument[]): SbisUniqueAttachment[] {
  const set = new SbisAttachmentSet();
  for (const d of docs) set.add(collectSbisAttachments(d, NOW));
  return set.revisions();
}

describe('скачивание образца на 403', () => {
  const [r] = uniqueOf([sbisDoc({ id: 'd1', link: 'https://disk.sbis.ru/d1' })]);
  const denied = { 'https://disk.sbis.ru/d1': new SbisAccessDenied('disk.sbis.ru/d1') };
  const readWith = (link: string, extra: Record<string, unknown> = {}) => async () =>
    SbisDocumentSchema.parse({
      Идентификатор: 'd1',
      Вложение: [{ Идентификатор: 'att-d1', Редакция: { Номер: '1' }, Файл: { Ссылка: link }, ...extra }],
    });

  it('свежая ссылка тоже 403 — причина не установлена', async () => {
    const { client } = fakeClient({
      files: { ...denied, 'https://disk.sbis.ru/again': new SbisAccessDenied('x') },
      read: readWith('https://disk.sbis.ru/again'),
    });
    expect(await downloadSample(client, r!, 1000)).toMatchObject({
      outcome: 'unknown',
      variant: 'by_revision',
      reason: expect.stringContaining('тоже отвечает 403'),
    });
  });

  it('ПрочитатьДокумент упал — unknown с причиной', async () => {
    const { client } = fakeClient({ files: denied });
    expect(await downloadSample(client, r!, 1000)).toMatchObject({
      outcome: 'unknown',
      reason: expect.stringContaining('ПрочитатьДокумент'),
    });
  });

  it('в ответе нет того вложения или другая редакция — unknown', async () => {
    const missing = fakeClient({ files: denied, read: async () => SbisDocumentSchema.parse({ Идентификатор: 'd1' }) });
    expect(await downloadSample(missing.client, r!, 1000)).toMatchObject({ outcome: 'unknown' });
    const otherRev = fakeClient({ files: denied, read: readWith('https://disk.sbis.ru/x', { Редакция: { Номер: '2' } }) });
    expect(await downloadSample(otherRev.client, r!, 1000)).toMatchObject({
      outcome: 'unknown',
      reason: expect.stringContaining('другую редакцию'),
    });
  });

  it('без идентификатора редакции в ленте — по документу, и это видно в отчёте', async () => {
    const noRev = { ...r!, documentRevisionId: null };
    const { client, calls } = fakeClient({ files: { ...denied, 'https://disk.sbis.ru/y': ZIP }, read: readWith('https://disk.sbis.ru/y') });
    expect(await downloadSample(client, noRev, 1000)).toMatchObject({ outcome: 'refreshed_ok', variant: 'by_document' });
    expect(calls.readDocument).toEqual([{ documentId: 'd1', revisionId: null }]);
  });

  it('ссылка на чужой хост — отдельный исход с именем хоста', async () => {
    const [foreign] = uniqueOf([sbisDoc({ id: 'd9', link: 'https://files.example.org/d9' })]);
    const { client } = fakeClient({
      files: { 'https://files.example.org/d9': new SbisRequestNotAllowed('запрос GET') },
    });
    expect(await downloadSample(client, foreign!, 1000)).toEqual({ outcome: 'host_not_allowed', host: 'files.example.org' });
  });
});

describe('подбор образцов', () => {
  it('и старые, и свежие события, разные продавцы — первыми', () => {
    const pool = uniqueOf([
      sbisDoc({ id: 'o1', eventTime: '01.08.2026 10.00.00', seller: '1000000001' }),
      sbisDoc({ id: 'o2', eventTime: '02.08.2026 10.00.00', seller: '1000000001' }),
      sbisDoc({ id: 'f1', eventTime: '18.10.2026 10.00.00', seller: '1000000002' }),
      sbisDoc({ id: 'f2', eventTime: '18.10.2026 11.00.00', seller: '1000000003' }),
    ]);
    const picked = pickSamples(pool, 3, NOW).map((r) => r.documentId);
    expect(picked).toHaveLength(3);
    expect(picked.some((id) => id.startsWith('o'))).toBe(true);
    expect(picked.some((id) => id.startsWith('f'))).toBe(true);
    // Два старых от одного продавца не вытесняют свежих от разных.
    expect(picked.filter((id) => id.startsWith('o'))).toHaveLength(1);
    expect(pickSamples(pool, 10, NOW)).toHaveLength(4);
  });
});
