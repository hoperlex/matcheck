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

const { inventoryBox } = await import('../src/domain/edo/inventory.js');
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
});
