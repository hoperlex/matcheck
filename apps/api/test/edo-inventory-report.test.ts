/**
 * Отчёт разведки ящика.
 *
 * Разведка — единственный способ узнать, что в ящике лежит, не импортировав ни
 * одной карточки. На боевом ящике 24.09.2026 она показала пустой период при
 * двух тысячах просмотренных событий, и отличить «времени нет» от «документов
 * нет» было нечем. Поэтому отчёт теперь отвечает и на этот вопрос.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 }),
}));

const { inventoryBox, EdoLeaseLost } = await import('../src/domain/edo/inventory.js');
type Client = Parameters<typeof inventoryBox>[0];

const TICKS = String(
  BigInt(Date.parse('2026-09-24T10:00:00.000Z')) * 10_000n + 621_355_968_000_000_000n,
);

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** Клиент, отдающий заданные страницы ленты и пустоту после них. */
function clientWith(pages: unknown[][]): Client {
  let page = 0;
  return {
    getNewEvents: async () => ({ events: (pages[page++] ?? []) as never[] }),
  } as unknown as Client;
}

/** УПД в сообщении: ровно та форма, что приходит с боевого ящика. */
function updEvent(opts: { eventTime?: string; messageTime?: string; id?: string }) {
  return {
    EventId: opts.id ?? 'e-1',
    IndexKey: `idx-${opts.id ?? 'e-1'}`,
    ...(opts.eventTime ? { Timestamp: opts.eventTime } : {}),
    Message: {
      MessageId: 'm-1',
      ToBoxId: 'box-наш',
      ...(opts.messageTime ? { Timestamp: opts.messageTime } : {}),
      Entities: [
        {
          EntityId: `ent-${opts.id ?? 'e-1'}`,
          EntityType: 'Attachment',
          DocumentInfo: {
            DocumentDirection: 'Inbound',
            TypeNamedId: 'UniversalTransferDocument',
            Function: 'СЧФДОП',
            Version: 'utd970_05_03_01',
          },
        },
      ],
    },
  };
}

describe('отчёт разведки', () => {
  it('считает время событий и называет его источник', async () => {
    // Боевой случай: у события времени нет, у сообщения — есть.
    const report = await inventoryBox(
      clientWith([[updEvent({ messageTime: TICKS, id: 'a' })]]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.timedEvents).toBe(1);
    expect(report.timeSource).toBe('message');
    expect(report.from).toBe('2026-09-24T10:00:00.000Z');
  });

  it('пустое время видно по отчёту, а не по пустому периоду', async () => {
    const report = await inventoryBox(
      clientWith([[updEvent({ id: 'b' })]]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.timedEvents).toBe(0);
    expect(report.timeSource).toBeNull();
    expect(report.from).toBeNull();
    // Документ при этом посчитан: «времени нет» и «ящик пуст» — разные вещи.
    expect(report.entitiesSeen).toBe(1);
  });

  it('раскладывает документы по типу, функции и версии', async () => {
    const report = await inventoryBox(
      clientWith([
        [
          updEvent({ messageTime: TICKS, id: 'c' }),
          updEvent({ messageTime: TICKS, id: 'd' }),
        ],
      ]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.byType).toHaveLength(1);
    expect(report.byType[0]).toMatchObject({
      typeNamedId: 'UniversalTransferDocument',
      function: 'СЧФДОП',
      version: 'utd970_05_03_01',
      formalized: true,
      count: 2,
    });
  });

  it('упёршись в предел, отчёт признаётся в неполноте', async () => {
    // Иначе цифры читались бы как «всё, что есть в ящике».
    const report = await inventoryBox(
      clientWith([
        [updEvent({ messageTime: TICKS, id: 'e' }), updEvent({ id: 'f' })],
        [updEvent({ messageTime: TICKS, id: 'g' })],
      ]),
      { boxId: 'box-наш', since: null, maxEvents: 1 },
      log,
    );
    expect(report.truncated).toBe(true);
    // Начатая страница дочитывается целиком, обрыв происходит на её границе:
    // событие — единица учёта ленты, и половина страницы сделала бы курсор
    // бессмысленным.
    expect(report.eventsSeen).toBe(2);
  });

  it('у каждого типа — решение отбора, исключённые считаются отдельно', async () => {
    const invoice = updEvent({ id: 'inv' });
    invoice.Message.Entities[0]!.DocumentInfo = {
      ...invoice.Message.Entities[0]!.DocumentInfo,
      TypeNamedId: 'Invoice',
      Function: 'default',
      Version: 'invoice_05_02_01',
    };
    const test = updEvent({ id: 'tst' });
    (test.Message.Entities[0]!.DocumentInfo as Record<string, unknown>).IsTest = true;

    const report = await inventoryBox(
      clientWith([[updEvent({ id: 'u' }), invoice, test]]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.byType.map((b) => [b.typeNamedId, b.decision, b.formalized])).toEqual([
      ['UniversalTransferDocument', 'utd_candidate', true],
      // Счёт-фактура в XML — машиночитаемая, хоть в разбор УПД и не идёт.
      ['Invoice', 'invoice', true],
    ]);
    const decisions = Object.fromEntries((report.decisions ?? []).map((d) => [d.category, d.count]));
    expect(decisions).toEqual({ utd_candidate: 1, invoice: 1, excluded: 1 });
    expect(report.entitiesSeen).toBe(3);
  });

  it('машиночитаемость и название типа — по справочнику Диадока, если он ответил', async () => {
    const client = {
      getNewEvents: clientWith([[updEvent({ id: 'r' })]]).getNewEvents,
      getDocumentTypes: async () => [
        {
          name: 'UniversalTransferDocument',
          title: 'УПД',
          versions: [{ fn: 'СЧФДОП', version: 'utd970_05_03_01', isFormal: true }],
        },
      ],
    } as unknown as Client;
    const report = await inventoryBox(client, { boxId: 'box-наш', since: null }, log);
    expect(report.byType[0]).toMatchObject({
      title: 'УПД',
      formalized: true,
      formalizedSource: 'reference',
    });
  });

  it('без проверки содержимого ничего не скачивается', async () => {
    const report = await inventoryBox(
      clientWith([[updEvent({ id: 'n' })]]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.contentCheck).toBeNull();
  });
});

const UTD_XML = (kind: number) => `<Файл><Документ Функция="СЧФДОП">
  <СвСчФакт НомерДок="1" ДатаДок="01.09.2026">
    <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО" ИННЮЛ="7712345678"/></ИдСв></СвПрод>
  </СвСчФакт>
  <ТаблСчФакт><СведТов НомСтр="1" НаимТов="Х" КолТов="1" СтТовУчНал="120"><ДопСведТов ПрТовРаб="${kind}"/></СведТов></ТаблСчФакт>
</Документ></Файл>`;

/** Клиент для проверки содержимого: документ `ent-sN` — услуга, прочие — материалы. */
function contentClient(ids: string[], opts: { hang?: boolean; brokenId?: string } = {}) {
  let page = 0;
  const downloads: string[] = [];
  const client = {
    getNewEvents: async () => ({
      events: (page++ === 0 ? ids.map((id) => updEvent({ id })) : []) as never[],
    }),
    getEntityContent: (_b: string, _m: string, entityId: string, _max: number, o: { signal?: AbortSignal }) => {
      downloads.push(entityId);
      if (opts.hang) {
        return new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (entityId === `ent-${opts.brokenId}`) return Promise.resolve(Buffer.from('не XML'));
      return Promise.resolve(Buffer.from(UTD_XML(entityId.startsWith('ent-s') ? 3 : 1), 'utf8'));
    },
  } as unknown as Client;
  return { client, downloads };
}

describe('проверка содержимого при осмотре', () => {
  it('считает, какие УПД — материалы, а какие — услуги', async () => {
    const { client } = contentClient(['m1', 'm2', 's1'], { brokenId: 'm2' });
    const report = await inventoryBox(
      client,
      {
        boxId: 'box-наш',
        since: null,
        contentCheck: { maxDownloads: 100, deadlineMs: 5_000, renewLease: async () => true },
      },
      log,
    );
    expect(report.contentCheck).toMatchObject({ checked: 2, failed: 1, interrupted: null });
    const byContent = Object.fromEntries(report.contentCheck!.byContent.map((c) => [c.category, c.count]));
    expect(byContent).toEqual({ materials: 1, services: 1 });
  });

  it('скачивает не больше предела и продлевает лиз по ходу', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    const { client, downloads } = contentClient(ids);
    let renewals = 0;
    await inventoryBox(
      client,
      {
        boxId: 'box-наш',
        since: null,
        contentCheck: {
          maxDownloads: 21,
          deadlineMs: 5_000,
          renewEvery: 10,
          renewLease: async () => {
            renewals += 1;
            return true;
          },
        },
      },
      log,
    );
    expect(downloads).toHaveLength(21);
    // Перед 11-м и 21-м скачиванием.
    expect(renewals).toBe(2);
  });

  it('лиз потерян — осмотр прекращается, отчёт не возвращается', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `m${i}`);
    const { client, downloads } = contentClient(ids);
    await expect(
      inventoryBox(
        client,
        {
          boxId: 'box-наш',
          since: null,
          contentCheck: { maxDownloads: 100, deadlineMs: 5_000, renewEvery: 10, renewLease: async () => false },
        },
        log,
      ),
    ).rejects.toBeInstanceOf(EdoLeaseLost);
    expect(downloads).toHaveLength(10);
  });

  it('по истечении времени — доли по проверенной части и пометка', async () => {
    const { client } = contentClient(['m1', 'm2'], { hang: true });
    const report = await inventoryBox(
      client,
      {
        boxId: 'box-наш',
        since: null,
        contentCheck: { maxDownloads: 100, deadlineMs: 30, renewLease: async () => true },
      },
      log,
    );
    expect(report.contentCheck).toMatchObject({ checked: 0, interrupted: 'deadline' });
  });
});
