/**
 * Клиент API Диадока: заголовки запроса и разбор ответа.
 *
 * Главная проверка — `Accept: application/json`. По умолчанию Диадок отдаёт
 * Protocol Buffers, и без этого заголовка ответы приходят бинарными: разбор
 * падает сразу на всех методах, а снаружи это выглядит как «проверка доступа не
 * удалась» — ровно так и сорвалась первая боевая проба. Ошибка тихая и
 * повторяемая, поэтому она закрыта тестом.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 }),
}));

const { DiadocClient, parseDocumentTypes } = await import('../src/domain/edo/diadoc.client.js');

/** Авторизация здесь не предмет проверки: отдаём готовый заголовок. */
const auth = { header: async () => 'Bearer token-123', invalidate: () => {} };

type Captured = { url: string; headers: Record<string, string> };

function clientWith(
  respond: (url: URL) => Response,
): { client: InstanceType<typeof DiadocClient>; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(url);
  }) as unknown as typeof fetch;

  return {
    client: new DiadocClient({ auth, environment: 'production', fetchImpl }),
    calls,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('заголовки запроса', () => {
  it('структурные методы просят JSON — иначе придёт Protocol Buffers', async () => {
    const { client, calls } = clientWith(() => json({ Organizations: [] }));
    await client.getMyOrganizations();
    expect(calls[0]?.headers.Accept).toBe('application/json');
    expect(calls[0]?.headers.Authorization).toBe('Bearer token-123');
  });

  it('JSON просят все структурные методы, а не один', async () => {
    const { client, calls } = clientWith((url) => {
      if (url.pathname.includes('GetNewEvents')) return json({ Events: [] });
      if (url.pathname.includes('GetMessage')) return json({ MessageId: 'msg-1', Entities: [] });
      return json({});
    });
    await client.getMyEmployee('box-1');
    await client.getNewEvents({ boxId: 'box-1' });
    await client.getMessage('box-1', 'msg-1');
    expect(calls.map((c) => c.headers.Accept)).toEqual([
      'application/json',
      'application/json',
      'application/json',
    ]);
  });

  it('содержимое документа JSON не просит: там сам файл', async () => {
    const { client, calls } = clientWith(() => new Response(Buffer.from('<Файл/>')));
    const body = await client.getEntityContent('box-1', 'msg-1', 'ent-1', 1024);
    expect(body.toString('utf-8')).toContain('Файл');
    expect(calls[0]?.headers.Accept).toBeUndefined();
  });
});

describe('обязательные параметры', () => {
  it('список организаций запрашивается без побочной регистрации', async () => {
    // autoRegister по умолчанию true и РЕГИСТРИРУЕТ пользователя в организации:
    // для интеграции, которая обещает только читать, это недопустимо.
    const { client, calls } = clientWith(() => json({ Organizations: [] }));
    await client.getMyOrganizations();
    expect(new URL(calls[0]!.url).searchParams.get('autoRegister')).toBe('false');
  });

  it('лента запрашивается с курсором и отсечкой', async () => {
    const { client, calls } = clientWith(() => json({ Events: [] }));
    await client.getNewEvents({
      boxId: 'box-1',
      afterIndexKey: 'idx-7',
      fromTimestamp: new Date('2026-09-01T00:00:00Z'),
    });
    const params = new URL(calls[0]!.url).searchParams;
    expect(params.get('afterIndexKey')).toBe('idx-7');
    expect(params.get('documentDirection')).toBe('Inbound');
    expect(params.get('timestampFromTicks')).toMatch(/^\d{18}$/);
  });
});

describe('разбор ответа', () => {
  it('организации и ящики раскладываются в плоский список', async () => {
    const { client } = clientWith(() =>
      json({
        Organizations: [
          {
            Inn: '7712345678',
            Kpp: '771201001',
            ShortName: 'ООО «СУ-10»',
            Boxes: [{ BoxId: 'box-1', Title: 'Основной' }],
          },
        ],
      }),
    );
    const boxes = await client.getMyOrganizations();
    expect(boxes).toEqual([
      { boxId: 'box-1', title: 'Основной', inn: '7712345678', kpp: '771201001' },
    ]);
  });

  it('незнакомые поля в ответе не ломают разбор', async () => {
    // API живой: новое поле на той стороне не должно останавливать приём.
    const { client } = clientWith(() =>
      json({ Organizations: [{ Inn: '1', Boxes: [{ BoxId: 'b', NewField: 42 }] }], Extra: true }),
    );
    await expect(client.getMyOrganizations()).resolves.toHaveLength(1);
  });
});

describe('справочник типов документов', () => {
  it('берёт тип, название и машиночитаемость первого титула', () => {
    const types = parseDocumentTypes({
      DocumentTypes: [
        {
          Name: 'UniversalTransferDocument',
          Title: 'УПД',
          Functions: [
            {
              Name: 'СЧФДОП',
              Versions: [
                {
                  Version: 'utd970_05_03_01',
                  Titles: [
                    { Index: 1, IsFormal: false },
                    { Index: 0, IsFormal: true },
                  ],
                },
              ],
            },
          ],
        },
        { Name: 'Nonformalized', Functions: [{ Name: 'default', Versions: [{ Version: 'v1', Titles: [] }] }] },
      ],
    });
    expect(types).toEqual([
      {
        name: 'UniversalTransferDocument',
        title: 'УПД',
        versions: [{ fn: 'СЧФДОП', version: 'utd970_05_03_01', isFormal: true }],
      },
      { name: 'Nonformalized', title: null, versions: [{ fn: 'default', version: 'v1', isFormal: null }] },
    ]);
  });

  it('незнакомая форма ответа даёт пустой справочник, а не падение', () => {
    expect(parseDocumentTypes(null)).toEqual([]);
    expect(parseDocumentTypes({ DocumentTypes: 'нет' })).toEqual([]);
    expect(parseDocumentTypes({ DocumentTypes: [{ Title: 'без имени' }, 5] })).toEqual([]);
  });
});

describe('список документов (V3)', () => {
  it('фильтры, границы в тиках, размер страницы и закодированный ключ', async () => {
    const { client, calls } = clientWith(() =>
      json({ Documents: [{ MessageId: 'm-1', EntityId: 'e-1', IndexKey: 'k+1/=' }], TotalCount: 1, HasMoreResults: false }),
    );
    const list = await client.getDocuments({
      boxId: 'box-1',
      filterCategory: 'UniversalTransferDocument.Inbound',
      fromTicks: 639_000_000_000_000_000n,
      toTicks: 639_000_000_000_000_999n,
      afterIndexKey: 'ключ+со/знаками=',
      count: 100,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/V3/GetDocuments');
    expect(url.searchParams.get('filterCategory')).toBe('UniversalTransferDocument.Inbound');
    expect(url.searchParams.get('timestampFromTicks')).toBe('639000000000000000');
    expect(url.searchParams.get('timestampToTicks')).toBe('639000000000000999');
    expect(url.searchParams.get('count')).toBe('100');
    // Ключ уходит закодированным и возвращается на сервере ровно таким, каким был.
    expect(calls[0]!.url).not.toContain('ключ+со/знаками=');
    expect(url.searchParams.get('afterIndexKey')).toBe('ключ+со/знаками=');
    expect(calls[0]!.headers.Accept).toBe('application/json');
    expect(list.Documents[0]?.IndexKey).toBe('k+1/=');
    expect(list.TotalCount).toBe(1);
  });

  it('без границ и ключа лишних параметров нет; направление сортировки передаётся', async () => {
    const { client, calls } = clientWith(() => json({ Documents: [] }));
    await client.getDocuments({ boxId: 'box-1', filterCategory: 'Any.Deleted', count: 1, sortDirection: 'Descending' });
    const url = new URL(calls[0]!.url);
    expect([...url.searchParams.keys()].sort()).toEqual(['boxId', 'count', 'filterCategory', 'sortDirection']);
    expect(url.searchParams.get('sortDirection')).toBe('Descending');
  });

  it('документ без MessageId ломает страницу целиком: сверять его не с чем', async () => {
    const { client } = clientWith(() => json({ Documents: [{ EntityId: 'e-1' }] }));
    await expect(client.getDocuments({ boxId: 'b', filterCategory: 'Any.Inbound' })).rejects.toThrow();
  });

  it('статусы-числа и незнакомые поля не роняют разбор', async () => {
    const { client } = clientWith(() =>
      json({
        Documents: [{ MessageId: 'm', EntityId: 'e', RevocationStatus: 4, SomethingNew: { a: 1 } }],
        TotalCount: 1000,
        HasMoreResults: true,
      }),
    );
    const list = await client.getDocuments({ boxId: 'b', filterCategory: 'Any.Inbound' });
    expect(list.Documents[0]?.RevocationStatus).toBe(4);
    expect(list.HasMoreResults).toBe(true);
  });
});
