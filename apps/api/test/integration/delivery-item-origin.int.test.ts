/**
 * Происхождение позиций приёмки и владение связями с документами.
 *
 * Зачем интеграционные: всё проверяемое живёт в SQL и в порядке операций внутри
 * транзакции — деструктивный upsert (DELETE + INSERT позиций), дедупликация при
 * привязке, сохранение атрибуции при отвязке. На моках это не воспроизводится:
 * там нет ни FK, ни реального переписывания строк.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import {
  deliveries,
  deliveryItems,
  deliverySources,
  sessions,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('происхождение позиций приёмки (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: {
        deliveries,
        deliveryItems,
        deliverySources,
        sessions,
        sites,
        sourceDocuments,
        sourceDocumentItems,
        statuses,
        users,
      },
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'IOR'}, 'Integration origin')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`ior-${managerId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;

    // На created_by_session_id висит FK, поэтому сессия должна существовать —
    // в бою её создаёт plugins/auth.ts на каждом запросе.
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    // delivery_items.source_document_id — RESTRICT, поэтому приёмки удаляем
    // раньше документов; иначе чистка упадёт на FK.
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  /** УПД с позициями. Возвращает id документа и id его строк по порядку. */
  async function makeUpd(
    docNumber: string,
    items: Array<{ name: string; qty: string; unit?: string }>,
  ): Promise<{ id: string; itemIds: string[] }> {
    const id = randomUUID();
    await sql`
      INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
      VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${docNumber}, now(), '100.00', now())`;
    const itemIds: string[] = [];
    for (const [idx, it] of items.entries()) {
      const itemId = randomUUID();
      itemIds.push(itemId);
      await sql`
        INSERT INTO source_document_items (id, source_document_id, name_raw, qty, unit, line_no)
        VALUES (${itemId}, ${id}, ${it.name}, ${it.qty}, ${it.unit ?? 'шт'}, ${idx + 1})`;
    }
    return { id, itemIds };
  }

  const upsert = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });

  const link = (deliveryId: string, sourceDocumentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${deliveryId}/link-source`,
      payload: { sourceDocumentId },
    });

  const unlink = (deliveryId: string, sourceDocumentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${deliveryId}/unlink-source`,
      payload: { sourceDocumentId },
    });

  async function itemsOf(deliveryId: string) {
    return await sql<
      {
        id: string;
        name_raw: string;
        line_no: number;
        source_document_id: string | null;
        source_document_item_id: string | null;
      }[]
    >`SELECT id, name_raw, line_no, source_document_id, source_document_item_id
        FROM delivery_items WHERE delivery_id = ${deliveryId} ORDER BY line_no`;
  }

  async function sourcesOf(deliveryId: string) {
    const rows = await sql<{ source_document_id: string }[]>`
      SELECT source_document_id FROM delivery_sources WHERE delivery_id = ${deliveryId}`;
    return rows.map((r) => r.source_document_id).sort();
  }

  /** Пустая приёмка без документов — отправная точка большинства сценариев. */
  async function makeDelivery(): Promise<string> {
    const id = randomUUID();
    const res = await upsert({
      id,
      statusCode: 'filled',
      siteId,
      items: [],
      sourceDocumentIds: [],
    });
    expect(res.statusCode, res.body).toBe(200);
    return id;
  }

  it('привязка документа проставляет позициям происхождение', async () => {
    const upd = await makeUpd('О-1', [{ name: 'Арматура 12', qty: '2' }]);
    const deliveryId = await makeDelivery();

    expect((await link(deliveryId, upd.id)).statusCode).toBe(200);

    const items = await itemsOf(deliveryId);
    expect(items).toHaveLength(1);
    expect(items[0]!.source_document_id).toBe(upd.id);
    expect(items[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('повторная привязка того же документа не двоит позиции', async () => {
    const upd = await makeUpd('О-2', [{ name: 'Цемент М500', qty: '10' }]);
    const deliveryId = await makeDelivery();

    await link(deliveryId, upd.id);
    const second = await link(deliveryId, upd.id);

    expect(second.statusCode).toBe(409);
    expect(await itemsOf(deliveryId)).toHaveLength(1);
  });

  it('одинаковые позиции двух УПД дают две строки', async () => {
    // Машина привезла два документа с одной и той же позицией. Раньше дедуп
    // шёл по всей приёмке и вторую строку гасил — приёмка занижалась.
    const first = await makeUpd('О-3', [{ name: 'Плита ПК 60', qty: '4' }]);
    const second = await makeUpd('О-4', [{ name: 'Плита ПК 60', qty: '4' }]);
    const deliveryId = await makeDelivery();

    await link(deliveryId, first.id);
    await link(deliveryId, second.id);

    const items = await itemsOf(deliveryId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.source_document_id).sort()).toEqual([first.id, second.id].sort());
  });

  it('upsert без поля происхождения не обнуляет атрибуцию (старый планшет)', async () => {
    const upd = await makeUpd('О-5', [{ name: 'Гипсокартон', qty: '30' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, upd.id);

    const before = await itemsOf(deliveryId);
    // Планшет присылает строку так, как умеет: с id и без sourceDocumentId.
    const res = await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [upd.id],
      items: [
        {
          id: before[0]!.id,
          nameRaw: before[0]!.name_raw,
          qtyActual: '28',
          unit: 'шт',
          lineNo: 1,
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const after = await itemsOf(deliveryId);
    expect(after[0]!.source_document_id).toBe(upd.id);
    expect(after[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('удаление строки из середины не рвёт атрибуцию соседей (портал)', async () => {
    // Портал шлёт позиции со своими id из БД и пересчитывает lineNo сплошняком
    // (KppPage.buildPatch), а происхождение не шлёт вовсе. После удаления
    // средней строки у оставшихся меняются и номер, и — если менеджер поправил
    // название — сам текст. Опознать их можно только по id.
    const upd = await makeUpd('О-5а', [
      { name: 'Уголок 50', qty: '3' },
      { name: 'Уголок 63', qty: '4' },
      { name: 'Уголок 75', qty: '5' },
    ]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, upd.id);

    const before = await itemsOf(deliveryId);
    expect(before).toHaveLength(3);
    const kept = [before[0]!, before[2]!];

    const res = await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [upd.id],
      items: kept.map((i, idx) => ({
        id: i.id,
        // Первую строку менеджер заодно переименовал — запасное сопоставление
        // по названию на ней бы не сработало.
        nameRaw: idx === 0 ? 'Уголок 50 (оцинк.)' : i.name_raw,
        unit: 'шт',
        lineNo: idx + 1,
      })),
    });

    expect(res.statusCode, res.body).toBe(200);
    const after = await itemsOf(deliveryId);
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.source_document_id)).toEqual([upd.id, upd.id]);
    expect(after.map((i) => i.source_document_item_id)).toEqual([upd.itemIds[0], upd.itemIds[2]]);
  });

  it('клиент не может переписать происхождение существующей строки', async () => {
    const mine = await makeUpd('О-6', [{ name: 'Кирпич', qty: '1000' }]);
    const other = await makeUpd('О-7', [{ name: 'Песок', qty: '5' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, mine.id);
    await link(deliveryId, other.id);

    const before = await itemsOf(deliveryId);
    const brick = before.find((i) => i.name_raw === 'Кирпич')!;

    await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [mine.id, other.id],
      items: before.map((i, idx) => ({
        id: i.id,
        nameRaw: i.name_raw,
        unit: 'шт',
        lineNo: idx + 1,
        // Подменяем происхождение кирпича на чужой документ.
        sourceDocumentId: i.id === brick.id ? other.id : i.source_document_id,
      })),
    });

    const after = await itemsOf(deliveryId);
    expect(after.find((i) => i.name_raw === 'Кирпич')!.source_document_id).toBe(mine.id);
  });

  it('новая строка не может сослаться на документ вне приёмки', async () => {
    const linked = await makeUpd('О-8', [{ name: 'Труба', qty: '3' }]);
    const foreign = await makeUpd('О-9', [{ name: 'Профиль', qty: '7' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, linked.id);

    await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [linked.id],
      items: [
        {
          nameRaw: 'Дописанное руками',
          unit: 'шт',
          lineNo: 1,
          sourceDocumentId: foreign.id,
          sourceDocumentItemId: foreign.itemIds[0],
        },
      ],
    });

    const after = await itemsOf(deliveryId);
    expect(after).toHaveLength(1);
    expect(after[0]!.source_document_id).toBeNull();
    expect(after[0]!.source_document_item_id).toBeNull();
  });

  it('upsert с урезанным набором не отвязывает документы', async () => {
    const first = await makeUpd('О-10', [{ name: 'Балка', qty: '2' }]);
    const second = await makeUpd('О-11', [{ name: 'Швеллер', qty: '2' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, first.id);
    await link(deliveryId, second.id);

    // Планшет знает только про первый документ и присылает его один.
    const res = await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [first.id],
      items: [],
    });

    expect(res.statusCode).toBe(200);
    expect(await sourcesOf(deliveryId)).toEqual([first.id, second.id].sort());
  });

  it('upsert не привязывает документы к существующей приёмке', async () => {
    const upd = await makeUpd('О-12', [{ name: 'Утеплитель', qty: '20' }]);
    const deliveryId = await makeDelivery();

    await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [upd.id],
      items: [],
    });

    expect(await sourcesOf(deliveryId)).toEqual([]);
  });

  it('отвязка снимает связь, но сохраняет позиции и их происхождение', async () => {
    const upd = await makeUpd('О-13', [{ name: 'Пеноблок', qty: '50' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, upd.id);

    const res = await unlink(deliveryId, upd.id);

    expect(res.statusCode).toBe(200);
    expect(await sourcesOf(deliveryId)).toEqual([]);
    const items = await itemsOf(deliveryId);
    expect(items).toHaveLength(1);
    expect(items[0]!.source_document_id).toBe(upd.id);
  });

  it('повторная привязка после отвязки не двоит позиции', async () => {
    const upd = await makeUpd('О-14', [{ name: 'Штукатурка', qty: '15' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, upd.id);
    await unlink(deliveryId, upd.id);

    expect((await link(deliveryId, upd.id)).statusCode).toBe(200);

    expect(await itemsOf(deliveryId)).toHaveLength(1);
    expect(await sourcesOf(deliveryId)).toEqual([upd.id]);
  });

  it('отвязка того, что не привязано, отвечает 404 и ничего не меняет', async () => {
    const upd = await makeUpd('О-15', [{ name: 'Краска', qty: '5' }]);
    const deliveryId = await makeDelivery();

    const res = await unlink(deliveryId, upd.id);

    expect(res.statusCode).toBe(404);
    expect(await itemsOf(deliveryId)).toHaveLength(0);
  });

  it('ручная приёмка без документов работает как прежде', async () => {
    // Инвариант «Создать приёмку» / «Ручной внос»: ни связей, ни атрибуции,
    // позиции целиком из запроса.
    const deliveryId = randomUUID();
    const res = await upsert({
      id: deliveryId,
      statusCode: 'confirmed_mol',
      siteId,
      sourceDocumentIds: [],
      items: [
        { nameRaw: 'Ветошь', qtyActual: '3', unit: 'кг', lineNo: 1 },
        { nameRaw: 'Перчатки', qtyActual: '10', unit: 'пар', lineNo: 2 },
      ],
    });

    expect(res.statusCode).toBe(200);
    const items = await itemsOf(deliveryId);
    expect(items.map((i) => i.name_raw)).toEqual(['Ветошь', 'Перчатки']);
    expect(items.every((i) => i.source_document_id === null)).toBe(true);
    expect(await sourcesOf(deliveryId)).toEqual([]);
  });

  it('backfill миграции сопоставляет только однозначное', async () => {
    // Гоняем ровно тот SQL, что уехал в 0096: он идемпотентен (WHERE
    // source_document_id IS NULL), поэтому повторный прогон на новых данных
    // безопасен и проверяет настоящую логику, а не её пересказ.
    const migration = await readFile(
      new URL('../../src/db/migrations/0096_multi_upd_delivery.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration.slice(migration.indexOf('WITH single_source AS ('));
    expect(backfill).toContain('UPDATE "delivery_items"');

    const upd = await makeUpd('О-17', [
      { name: 'Профлист С8', qty: '12' },
      { name: 'Саморез кровельный', qty: '500' },
      { name: 'Саморез кровельный', qty: '500' },
    ]);
    const deliveryId = await makeDelivery();
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
      VALUES (${deliveryId}, ${upd.id})`;
    // Позиции кладём напрямую, без атрибуции — так выглядит история до 0096.
    await sql`INSERT INTO delivery_items (delivery_id, name_raw, qty_planned, unit, line_no) VALUES
      (${deliveryId}, 'Профлист С8', '12', 'шт', 1),
      (${deliveryId}, 'Саморез кровельный', '500', 'шт', 2),
      (${deliveryId}, 'Саморез кровельный', '500', 'шт', 3),
      (${deliveryId}, 'Саморез кровельный', '250', 'шт', 4),
      (${deliveryId}, 'Ветошь', '2', 'кг', 5)`;

    await sql.unsafe(backfill);

    const items = await itemsOf(deliveryId);
    const byName = (name: string, lineNo: number) =>
      items.find((i) => i.name_raw === name && i.line_no === lineNo)!;

    // Однозначная строка получила и документ, и точную строку-источник.
    expect(byName('Профлист С8', 1).source_document_id).toBe(upd.id);
    expect(byName('Профлист С8', 1).source_document_item_id).toBe(upd.itemIds[0]);

    // «Саморезов» в приёмке три, в документе два — ключ неоднозначен целиком,
    // и ни одна из трёх строк атрибуции не получает.
    expect(byName('Саморез кровельный', 2).source_document_id).toBeNull();
    expect(byName('Саморез кровельный', 3).source_document_id).toBeNull();
    expect(byName('Саморез кровельный', 4).source_document_id).toBeNull();

    // Ручная строка остаётся без происхождения — приписать её УПД было бы
    // враньём в интерфейсе.
    expect(byName('Ветошь', 5).source_document_id).toBeNull();
  });

  it('служебную запись пакета к приёмке привязать нельзя', async () => {
    // Промежуточный документ сборки логических УПД остаётся техническим до
    // публикации: его позиции ещё меняются, а часть страниц может быть не
    // распознана. Привязать такой документ — значит принять половину поставки.
    const techId = randomUUID();
    await sql`
      INSERT INTO source_documents (id, kind, direction, status, origin, site_id, is_technical)
      VALUES (${techId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, true)`;
    const deliveryId = await makeDelivery();

    const linked = await link(deliveryId, techId);
    expect(linked.statusCode).toBe(404);

    // И при создании приёмки — тоже: там набор связей берётся из запроса.
    const created = await upsert({
      id: randomUUID(),
      statusCode: 'filled',
      siteId,
      items: [],
      sourceDocumentIds: [techId],
    });
    expect(created.statusCode).toBe(404);
    expect(await sourcesOf(deliveryId)).toEqual([]);
  });

  it('сводка sourceDocuments: связанные первыми, отвязанный остаётся с linked:false', async () => {
    // Шапка карточки считает номера и суммы по linked, блоки материалов — по
    // всем упомянутым. Поэтому отвязанный документ обязан приехать в сводке, но
    // с linked:false: иначе его блок остался бы без подписи.
    const first = await makeUpd('О-17', [{ name: 'Труба 108', qty: '3' }]);
    const second = await makeUpd('О-18', [{ name: 'Отвод 108', qty: '6' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, first.id);
    await link(deliveryId, second.id);
    expect((await unlink(deliveryId, first.id)).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}` });
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as {
      sourceDocumentIds: string[];
      sourceDocuments: {
        id: string;
        linked: boolean;
        docNumber: string | null;
        docDate: string | null;
      }[];
    };

    expect(dto.sourceDocumentIds).toEqual([second.id]);
    expect(dto.sourceDocuments.map((d) => d.id)).toEqual([second.id, first.id]);
    expect(dto.sourceDocuments.map((d) => d.linked)).toEqual([true, false]);
    expect(dto.sourceDocuments.map((d) => d.docNumber)).toEqual(['О-18', 'О-17']);
    // Дата — YYYY-MM-DD, а не ISO-таймстемп: карточка печатает её как есть.
    expect(dto.sourceDocuments[0]!.docDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Позиции обоих документов на месте — отвязка их не трогает.
    const items = await itemsOf(deliveryId);
    expect(items.map((i) => i.source_document_id).sort()).toEqual([first.id, second.id].sort());
  });

  it('связанный документ без позиций всё равно попадает в сводку', async () => {
    // Распознавание не дало ни одной строки — блок «Материалы · УПД № … (0)»
    // должен появиться, иначе документ исчезает из карточки целиком.
    const empty = await makeUpd('О-19', []);
    const deliveryId = await makeDelivery();
    expect((await link(deliveryId, empty.id)).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}` });
    const dto = res.json() as { sourceDocuments: { id: string; linked: boolean }[] };
    expect(dto.sourceDocuments).toEqual([expect.objectContaining({ id: empty.id, linked: true })]);
    expect(await itemsOf(deliveryId)).toHaveLength(0);
  });

  it('форма одиночного DTO совпадает с элементом списка', async () => {
    // Инвариант «batch == одиночный» держался на комментарии: sources и photos
    // не сортировались вовсе, а lineNo дублируется. Сверяем то, что сравнимо:
    // порядок позиций, порядок связей и всю сводку документов.
    const first = await makeUpd('О-20', [{ name: 'Швеллер 16', qty: '2' }]);
    const second = await makeUpd('О-21', [{ name: 'Уголок 50', qty: '8' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, first.id);
    await link(deliveryId, second.id);

    const single = (
      await app.inject({ method: 'GET', url: `/api/v1/deliveries/${deliveryId}` })
    ).json() as Record<string, unknown>;
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/deliveries?limit=200' });
    expect(listRes.statusCode, listRes.body).toBe(200);
    const fromList = (listRes.json() as { items: Record<string, unknown>[] }).items.find(
      (d) => d.id === deliveryId,
    );

    expect(fromList).toBeDefined();
    expect(fromList!.sourceDocuments).toEqual(single.sourceDocuments);
    expect(fromList!.sourceDocumentIds).toEqual(single.sourceDocumentIds);
    expect((fromList!.items as { id: string }[]).map((i) => i.id)).toEqual(
      (single.items as { id: string }[]).map((i) => i.id),
    );
    // В батче есть ещё и primarySourceDocument — он обязан указывать на первый
    // элемент сводки, иначе список и карточка назовут «основными» разные бумаги.
    const primary = fromList!.primarySourceDocument as { id: string } | null;
    expect(primary?.id).toBe((single.sourceDocuments as { id: string }[])[0]!.id);
  });

  it('сохранение приёмки из нескольких документов не теряет строк и происхождения', async () => {
    // Карточка показывает материалы блоками по документам, но в state и в
    // payload они остаются одним плоским списком: upsert переписывает
    // delivery_items целиком, и строка, выпавшая из списка, исчезла бы из БД.
    const first = await makeUpd('О-22', [
      { name: 'Кабель ВВГнг 3х2.5', qty: '100' },
      { name: 'Гофра 20', qty: '50' },
    ]);
    const second = await makeUpd('О-23', [{ name: 'Щит ЩРН-12', qty: '2' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, first.id);
    await link(deliveryId, second.id);

    const before = await itemsOf(deliveryId);
    expect(before).toHaveLength(3);

    // Правим одну строку и добавляем новую в блок второго документа — ровно то,
    // что делает кнопка «+ Материал» в заголовке блока.
    const res = await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [first.id, second.id],
      items: [
        ...before.map((i) => ({
          id: i.id,
          nameRaw: i.name_raw,
          qtyActual: i.name_raw === 'Гофра 20' ? '45' : null,
          unit: 'шт',
          lineNo: i.line_no,
        })),
        {
          nameRaw: 'Клеммник WAGO',
          qtyPlanned: '10',
          unit: 'шт',
          lineNo: 4,
          sourceDocumentId: second.id,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await itemsOf(deliveryId);
    expect(after).toHaveLength(4);
    // Ни одна строка не потеряла свой документ.
    expect(after.filter((i) => i.source_document_id === first.id)).toHaveLength(2);
    expect(after.filter((i) => i.source_document_id === second.id)).toHaveLength(2);
    // Новая строка получила происхождение блока, в который её добавили.
    const added = after.find((i) => i.name_raw === 'Клеммник WAGO')!;
    expect(added.source_document_id).toBe(second.id);
    expect(added.source_document_item_id).toBeNull();
  });

  it('происхождение из запроса принимается только для привязанных документов', async () => {
    // Клиент не должен уметь приписать строку чужой бумаге: у карточки блоки
    // подписаны документами приёмки, и «чужое» происхождение сделало бы блок,
    // которого в поставке нет.
    const linked = await makeUpd('О-24', [{ name: 'Лоток 100', qty: '5' }]);
    const foreign = await makeUpd('О-25', [{ name: 'Крышка лотка', qty: '5' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, linked.id);

    const res = await upsert({
      id: deliveryId,
      statusCode: 'filled',
      siteId,
      sourceDocumentIds: [linked.id],
      items: [
        {
          nameRaw: 'Подвес',
          qtyPlanned: '3',
          unit: 'шт',
          lineNo: 9,
          sourceDocumentId: foreign.id,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);

    const items = await itemsOf(deliveryId);
    const added = items.find((i) => i.name_raw === 'Подвес')!;
    expect(added.source_document_id).toBeNull();
  });

  it('документ, чьи позиции лежат в приёмке, удалить нельзя', async () => {
    const upd = await makeUpd('О-16', [{ name: 'Саморезы', qty: '1000' }]);
    const deliveryId = await makeDelivery();
    await link(deliveryId, upd.id);
    await unlink(deliveryId, upd.id);

    // Связи уже нет, но происхождение осталось — RESTRICT держит документ.
    await expect(sql`DELETE FROM source_documents WHERE id = ${upd.id}`).rejects.toMatchObject({
      code: '23503',
    });
  });
});
