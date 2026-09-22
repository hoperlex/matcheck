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

const { DiadocClient } = await import('../src/domain/edo/diadoc.client.js');

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
