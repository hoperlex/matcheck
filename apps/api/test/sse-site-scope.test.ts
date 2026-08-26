/**
 * Скоуп SSE по объекту: планшет обязан просыпаться на СВОЙ объект, а не на все.
 *
 * До скоупа /api/v1/events рассылал каждое событие всем подключённым, и любая
 * приёмка на любом объекте будила планшеты всех объектов сразу. Замер 25.08 на
 * бою: 712 запросов /sync за полчаса при медиане обработчика 3,3 с — одна эта
 * ручка занимала больше целого ядра, и из-за общей загрузки медленно отвечали в
 * том числе запросы, реально везущие приёмку на второй планшет. Побочно поток
 * раскрывал инспектору id и типы чужих сущностей (metadata-leak, признанный
 * комментарием в самом маршруте).
 *
 * Проверяем две вещи раздельно, потому что ломаются они по-разному:
 *   1) правила фильтра — чистой функцией, все ветки;
 *   2) что фильтр РЕАЛЬНО включён в слушателе — двумя живыми HTTP-потоками.
 * Первое без второго зелено и при неподключённой функции.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { SseEvent } from '@matcheck/contracts';

// Redis-мост здесь не предмет проверки: события публикуем локальной шиной.
vi.mock('../src/domain/sse/redis-bridge.js', () => ({
  startSseSubscriber: vi.fn(),
  publishSseEvent: vi.fn(),
}));

const { eventsRoutes, publishEvent, shouldDeliverSseEvent } = await import(
  '../src/routes/events.js'
);

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTITY = '33333333-3333-4333-8333-333333333333';

const inspectorA = { role: 'inspector_kpp' as const, id: USER_A, siteId: SITE_A };
const inspectorB = { role: 'inspector_kpp' as const, id: USER_B, siteId: SITE_B };
const manager = { role: 'manager' as const, id: USER_A, siteId: null };

const evt = (over: Partial<SseEvent> = {}): SseEvent => ({
  type: 'delivery_updated',
  entityId: ENTITY,
  ts: new Date().toISOString(),
  ...over,
});

describe('правила доставки события', () => {
  it('инспектор получает события своего объекта', () => {
    expect(shouldDeliverSseEvent(evt({ siteId: SITE_A }), inspectorA)).toBe(true);
  });

  it('инспектор НЕ получает события чужого объекта', () => {
    expect(shouldDeliverSseEvent(evt({ siteId: SITE_B }), inspectorA)).toBe(false);
  });

  it('портал видит оба объекта — его поведение не меняется', () => {
    expect(shouldDeliverSseEvent(evt({ siteId: SITE_A }), manager)).toBe(true);
    expect(shouldDeliverSseEvent(evt({ siteId: SITE_B }), manager)).toBe(true);
  });

  it('событие без объекта доставляется всем: справочники остаются глобальными', () => {
    // Это же свойство делает безопасной ЧАСТИЧНУЮ разметку источников:
    // забытый publishEvent даёт лишний трафик, а не потерянное событие.
    expect(shouldDeliverSseEvent(evt({ type: 'material_updated' }), inspectorA)).toBe(true);
    expect(shouldDeliverSseEvent(evt({ type: 'counterparty_updated' }), inspectorB)).toBe(true);
  });

  it('ping доставляется всегда — иначе соединение умрёт по таймауту', () => {
    expect(shouldDeliverSseEvent(evt({ type: 'ping', siteId: SITE_B }), inspectorA)).toBe(true);
  });

  it('user_updated приходит только адресату', () => {
    // По siteId это событие фильтровать нельзя: при ПЕРЕВОДЕ на другой объект
    // оно несёт новый siteId, а планшет ещё числится на старом — адресат не
    // узнал бы о собственном переводе.
    expect(shouldDeliverSseEvent(evt({ type: 'user_updated', entityId: USER_A }), inspectorA)).toBe(
      true,
    );
    expect(shouldDeliverSseEvent(evt({ type: 'user_updated', entityId: USER_B }), inspectorA)).toBe(
      false,
    );
    expect(
      shouldDeliverSseEvent(
        evt({ type: 'user_updated', entityId: USER_B, siteId: SITE_A }),
        inspectorA,
      ),
    ).toBe(false);
  });

  it('инспектор без объекта получает только глобальные события', () => {
    const homeless = { role: 'inspector_kpp' as const, id: USER_A, siteId: null };
    expect(shouldDeliverSseEvent(evt({ siteId: SITE_A }), homeless)).toBe(false);
    expect(shouldDeliverSseEvent(evt({ type: 'material_updated' }), homeless)).toBe(true);
  });

  it('delete-событие фильтруется так же, как update', () => {
    // Своя ветка теста: siteId для удаления читается ДО удаления строки, и
    // регресс здесь означал бы, что карточка не уходит с планшета никогда.
    expect(shouldDeliverSseEvent(evt({ type: 'delivery_deleted', siteId: SITE_A }), inspectorA)).toBe(
      true,
    );
    expect(shouldDeliverSseEvent(evt({ type: 'delivery_deleted', siteId: SITE_B }), inspectorA)).toBe(
      false,
    );
  });
});

describe('фильтр включён в живом потоке', () => {
  let app: FastifyInstance;
  let base: string;
  // Кем представляется следующий подключившийся: маршрут читает req.user,
  // который в бою заполняет authenticate.
  let nextUser: { role: string; id: string; siteId: string | null };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate('authenticate', async (req: { user?: unknown }) => {
      req.user = { ...nextUser, contractorCustomerId: null, sessionId: 'test' };
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(eventsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Подключает поток и накапливает пришедший текст. */
  async function connect(user: typeof nextUser): Promise<{
    text: () => string;
    close: () => void;
  }> {
    nextUser = user;
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    let acc = '';
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
        }
      } catch {
        /* поток закрыт — это нормальное завершение */
      }
    })();
    // Дожидаемся первого чанка (':ok'), иначе подписчик может не успеть встать
    // на шину до публикации, и тест провалится по гонке, а не по существу.
    for (let i = 0; i < 50 && !acc.includes(':ok'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(acc).toContain(':ok');
    return { text: () => acc, close: () => ac.abort() };
  }

  it('событие объекта А доходит до инспектора А и не доходит до инспектора Б', async () => {
    const a = await connect(inspectorA);
    const b = await connect(inspectorB);

    publishEvent(app, {
      type: 'delivery_updated',
      entityId: ENTITY,
      siteId: SITE_A,
      ts: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(a.text(), 'свой объект — событие обязано дойти').toContain(ENTITY);
    expect(b.text(), 'чужой объект — событие не должно дойти').not.toContain(ENTITY);

    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('событие без объекта доходит до обоих', async () => {
    const a = await connect(inspectorA);
    const b = await connect(inspectorB);

    publishEvent(app, {
      type: 'material_updated',
      entityId: ENTITY,
      ts: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(a.text()).toContain('material_updated');
    expect(b.text()).toContain('material_updated');

    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('менеджер получает события обоих объектов', async () => {
    const m = await connect(manager);

    publishEvent(app, {
      type: 'shipment_updated',
      entityId: ENTITY,
      siteId: SITE_B,
      ts: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(m.text()).toContain(ENTITY);

    m.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});
