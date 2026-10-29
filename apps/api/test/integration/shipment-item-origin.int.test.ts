/**
 * Происхождение позиций отгрузки и владение связями с документами.
 *
 * Зеркало delivery-item-origin.int.test.ts. Отгрузка отстала от приёмки на три
 * правила сразу, и все три ловятся только на живой БД: link-source не писал
 * происхождение и дедуплицировал по всей отгрузке (одинаковая строка второй УПД
 * пропадала), а upsert переписывал набор связей по присланному списку.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import {
  sessions,
  shipments,
  shipmentItems,
  shipmentSources,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('происхождение позиций отгрузки (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const SHIPPED_AT = '2026-08-28T09:00:00.000Z';

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: {
        sessions,
        shipments,
        shipmentItems,
        shipmentSources,
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
    await app.register(shipmentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'ISO'}, 'Integration shipment origin')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`iso-${managerId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;
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
    // shipment_items.source_document_id — RESTRICT: отгрузки удаляем раньше
    // документов, иначе чистка упадёт на FK.
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function makeUpd(
    docNumber: string,
    items: Array<{ name: string; qty: string; unit?: string }>,
  ): Promise<{ id: string; itemIds: string[] }> {
    const id = randomUUID();
    await sql`
      INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
      VALUES (${id}, 'upd', 'outbound', 'parsed', 'manual_pdf', ${siteId}, ${docNumber}, now(), '100.00', now())`;
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
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  const link = (shipmentId: string, sourceDocumentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/shipments/${shipmentId}/link-source`,
      payload: { sourceDocumentId },
    });

  const unlink = (shipmentId: string, sourceDocumentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/shipments/${shipmentId}/unlink-source`,
      payload: { sourceDocumentId },
    });

  async function itemsOf(shipmentId: string) {
    return await sql<
      {
        id: string;
        name_raw: string;
        line_no: number;
        source_document_id: string | null;
        source_document_item_id: string | null;
      }[]
    >`SELECT id, name_raw, line_no, source_document_id, source_document_item_id
        FROM shipment_items WHERE shipment_id = ${shipmentId} ORDER BY line_no, id`;
  }

  async function sourcesOf(shipmentId: string) {
    const rows = await sql<{ source_document_id: string }[]>`
      SELECT source_document_id FROM shipment_sources WHERE shipment_id = ${shipmentId}`;
    return rows.map((r) => r.source_document_id).sort();
  }

  /** См. одноимённый помощник в delivery-item-origin.int.test.ts. */
  async function waitForLockWaiter(queryPrefix: string): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const rows = await sql`
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE ${queryPrefix + '%'}`;
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`запрос «${queryPrefix}…» не встал в ожидание блокировки`);
  }

  const shipmentBody = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    statusCode: 'shipped',
    // Списание: получатель не нужен, и тест не тянет за собой справочник
    // контрагентов — предмет проверки в происхождении позиций, а не в kind.
    kind: 'writeoff',
    siteId,
    shippedAt: SHIPPED_AT,
    items: [],
    sourceDocumentIds: [],
    ...extra,
  });

  async function makeShipment(): Promise<string> {
    const id = randomUUID();
    const res = await upsert(shipmentBody(id));
    expect(res.statusCode, res.body).toBe(200);
    return id;
  }

  it('привязка документа проставляет позициям происхождение', async () => {
    // Раньше строки вставлялись без source_document_id вовсе — материалы
    // отгрузки в карточке оказались бы все «без привязки к документу».
    const upd = await makeUpd('ОО-1', [{ name: 'Арматура 12', qty: '2' }]);
    const shipmentId = await makeShipment();

    expect((await link(shipmentId, upd.id)).statusCode).toBe(200);

    const items = await itemsOf(shipmentId);
    expect(items).toHaveLength(1);
    expect(items[0]!.source_document_id).toBe(upd.id);
    expect(items[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('строка, созданная без происхождения, получает привязку следующим сохранением', async () => {
    // Зеркало сценария приёмки 14289: при создании происхождение берётся только
    // из запроса, поэтому строка ложится с null. Раньше вернуть ей привязку
    // было нельзя уже никогда — пустое наследство перекрывало присланное.
    const upd = await makeUpd('ОО-1а', [{ name: 'ЦПС-С5', qty: '22', unit: 'м³' }]);
    const shipmentId = randomUUID();

    const created = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [upd.id],
        items: [{ nameRaw: 'ЦПС-С5', qtyActual: '22', unit: 'шт', lineNo: 1 }],
      }),
    );
    expect(created.statusCode, created.body).toBe(200);

    const before = await itemsOf(shipmentId);
    expect(before[0]!.source_document_id).toBeNull();

    const again = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [upd.id],
        items: [
          {
            id: before[0]!.id,
            nameRaw: 'ЦПС-С5',
            qtyActual: '22',
            unit: 'шт',
            lineNo: 1,
            sourceDocumentId: upd.id,
            sourceDocumentItemId: upd.itemIds[0],
          },
        ],
      }),
    );
    expect(again.statusCode, again.body).toBe(200);

    const after = await itemsOf(shipmentId);
    expect(after[0]!.source_document_id).toBe(upd.id);
    expect(after[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('одинаковые позиции двух УПД дают две строки', async () => {
    // Дедуп шёл по всей отгрузке: одинаковая строка второй УПД молча
    // пропадала, и отгрузка занижалась ровно на неё.
    const first = await makeUpd('ОО-2', [{ name: 'Плита ПК 60', qty: '4' }]);
    const second = await makeUpd('ОО-3', [{ name: 'Плита ПК 60', qty: '4' }]);
    const shipmentId = await makeShipment();

    await link(shipmentId, first.id);
    await link(shipmentId, second.id);

    const items = await itemsOf(shipmentId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.source_document_id).sort()).toEqual([first.id, second.id].sort());
  });

  it('удаление строки из середины не обнуляет происхождение остальных', async () => {
    // Клиент шлёт строки со СВОИМИ id (serverId). Раньше он генерировал новый
    // uuid каждой строке, сопоставление по id не срабатывало никогда, а
    // запасное (название, единица, номер) рвалось от сдвига номеров.
    const upd = await makeUpd('ОО-4', [
      { name: 'Швеллер 16', qty: '1' },
      { name: 'Уголок 50', qty: '2' },
      { name: 'Лист 4мм', qty: '3' },
    ]);
    const shipmentId = await makeShipment();
    await link(shipmentId, upd.id);

    const before = await itemsOf(shipmentId);
    expect(before).toHaveLength(3);

    const kept = before.filter((i) => i.name_raw !== 'Уголок 50');
    const res = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [upd.id],
        items: kept.map((i) => ({
          id: i.id,
          nameRaw: i.name_raw,
          qtyPlanned: '1',
          unit: 'шт',
          lineNo: i.line_no,
        })),
      }),
    );
    expect(res.statusCode, res.body).toBe(200);

    const after = await itemsOf(shipmentId);
    expect(after).toHaveLength(2);
    expect(after.every((i) => i.source_document_id === upd.id)).toBe(true);
    expect(after.map((i) => i.source_document_item_id).every((v) => v !== null)).toBe(true);
  });

  it('upsert с устаревшим списком документов не стирает привязки', async () => {
    // Клиент знает про одну УПД, менеджер привязал вторую. Раньше upsert делал
    // DELETE всех связей + INSERT присланного — вторая связь исчезала.
    const first = await makeUpd('ОО-5', [{ name: 'Гипсокартон', qty: '30' }]);
    const second = await makeUpd('ОО-6', [{ name: 'Профиль CD', qty: '50' }]);
    const shipmentId = await makeShipment();
    await link(shipmentId, first.id);
    await link(shipmentId, second.id);

    const res = await upsert(shipmentBody(shipmentId, { sourceDocumentIds: [first.id] }));
    expect(res.statusCode, res.body).toBe(200);

    expect(await sourcesOf(shipmentId)).toEqual([first.id, second.id].sort());
  });

  it('отвязка сохраняет позиции и их происхождение', async () => {
    const upd = await makeUpd('ОО-7', [{ name: 'Саморезы', qty: '1000' }]);
    const shipmentId = await makeShipment();
    await link(shipmentId, upd.id);

    expect((await unlink(shipmentId, upd.id)).statusCode).toBe(200);

    expect(await sourcesOf(shipmentId)).toEqual([]);
    const items = await itemsOf(shipmentId);
    expect(items).toHaveLength(1);
    expect(items[0]!.source_document_id).toBe(upd.id);

    // Повторная отвязка — 404 not_linked, а не молчаливый успех.
    expect((await unlink(shipmentId, upd.id)).statusCode).toBe(404);
  });

  // Зеркало приёмки (delivery-item-origin.int.test.ts, «отвязка с удалением
  // строк блока»): удаление всего блока, сверка версии, вторая вкладка и
  // пересечение отвязки с upsert. У отгрузки отвязка раньше не брала строку
  // операции первой — теперь берёт, иначе с upsert возможна взаимная блокировка.
  describe('отвязка с удалением строк блока', () => {
    const unlinkDeleting = (shipmentId: string, sourceDocumentId: string, baseVersion?: number) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/shipments/${shipmentId}/unlink-source`,
        payload: {
          sourceDocumentId,
          deleteItems: true,
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        },
      });

    async function versionOf(shipmentId: string): Promise<number> {
      const [row] = await sql<{ version: number }[]>`
        SELECT version FROM shipments WHERE id = ${shipmentId}`;
      return row!.version;
    }

    const asUpsertItems = (rows: Awaited<ReturnType<typeof itemsOf>>) =>
      rows.map((r) => ({
        id: r.id,
        nameRaw: r.name_raw,
        qtyPlanned: '1',
        unit: 'шт',
        lineNo: r.line_no,
        sourceDocumentId: r.source_document_id,
        sourceDocumentItemId: r.source_document_item_id,
      }));

    const save = (shipmentId: string, baseVersion: number, items: unknown[]) =>
      upsert(shipmentBody(shipmentId, { baseVersion, items }));

    async function twoDocShipment(tag: string) {
      const first = await makeUpd(`${tag}-1`, [
        { name: `${tag} Швеллер`, qty: '2' },
        { name: `${tag} Уголок`, qty: '3' },
      ]);
      const second = await makeUpd(`${tag}-2`, [{ name: `${tag} Лист`, qty: '1' }]);
      const shipmentId = await makeShipment();
      expect((await link(shipmentId, first.id)).statusCode).toBe(200);
      expect((await link(shipmentId, second.id)).statusCode).toBe(200);
      return { first, second, shipmentId };
    }

    it('удаляет весь блок документа, включая строку, добавленную в него вручную', async () => {
      const { first, second, shipmentId } = await twoDocShipment('ОУ-1');
      const saved = await save(shipmentId, await versionOf(shipmentId), [
        ...asUpsertItems(await itemsOf(shipmentId)),
        {
          nameRaw: 'Ручная в блоке',
          qtyPlanned: '1',
          unit: 'шт',
          lineNo: 10,
          sourceDocumentId: first.id,
        },
        {
          nameRaw: 'Без привязки',
          qtyPlanned: '1',
          unit: 'шт',
          lineNo: 11,
          sourceDocumentId: null,
        },
      ]);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(
        (await itemsOf(shipmentId)).filter((i) => i.source_document_id === first.id),
      ).toHaveLength(3);

      const res = await unlinkDeleting(shipmentId, first.id, await versionOf(shipmentId));

      expect(res.statusCode, res.body).toBe(200);
      const after = await itemsOf(shipmentId);
      expect(after.map((i) => i.name_raw).sort()).toEqual(['Без привязки', 'ОУ-1 Лист']);
      expect(await sourcesOf(shipmentId)).toEqual([second.id]);
    });

    it('устаревшая версия — 409, без baseVersion — 400, связь и строки на месте', async () => {
      const upd = await makeUpd('ОУ-2', [{ name: 'ОУ-2 Труба', qty: '4' }]);
      const shipmentId = await makeShipment();
      await link(shipmentId, upd.id);
      const seen = await versionOf(shipmentId);
      const bumped = await save(shipmentId, seen, asUpsertItems(await itemsOf(shipmentId)));
      expect(bumped.statusCode, bumped.body).toBe(200);

      const stale = await unlinkDeleting(shipmentId, upd.id, seen);
      expect(stale.statusCode, stale.body).toBe(409);
      expect((await unlinkDeleting(shipmentId, upd.id)).statusCode).toBe(400);

      expect(await sourcesOf(shipmentId)).toEqual([upd.id]);
      expect(await itemsOf(shipmentId)).toHaveLength(1);
    });

    it('документ, отвязанный раньше без удаления, — 404, его строки целы', async () => {
      const upd = await makeUpd('ОУ-3', [{ name: 'ОУ-3 Балка', qty: '2' }]);
      const shipmentId = await makeShipment();
      await link(shipmentId, upd.id);
      await unlink(shipmentId, upd.id);

      const res = await unlinkDeleting(shipmentId, upd.id, await versionOf(shipmentId));

      expect(res.statusCode).toBe(404);
      expect(await itemsOf(shipmentId)).toHaveLength(1);
    });

    it('полный путь одной вкладки и вторая вкладка со старым списком', async () => {
      const { first, second, shipmentId } = await twoDocShipment('ОУ-4');
      const v = await versionOf(shipmentId);
      const snapshot = await itemsOf(shipmentId);

      expect((await unlinkDeleting(shipmentId, first.id, v)).statusCode).toBe(200);

      // Вторая вкладка открыта до отвязки и шлёт старый список — 409.
      const stale = await save(shipmentId, v, asUpsertItems(snapshot));
      expect(stale.statusCode, stale.body).toBe(409);

      // Эта вкладка сохраняет оставшиеся строки с версией ответа отвязки.
      const kept = asUpsertItems(snapshot.filter((i) => i.source_document_id !== first.id)).map(
        (i) => ({ ...i, qtyPlanned: '7' }),
      );
      const res = await save(shipmentId, v + 1, kept);
      expect(res.statusCode, res.body).toBe(200);

      const reread = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipmentId}` });
      const dto = reread.json() as {
        items: { qtyPlanned: string | null; sourceDocumentId: string | null }[];
      };
      expect(dto.items).toHaveLength(1);
      expect(dto.items[0]).toMatchObject({ sourceDocumentId: second.id });
      expect(Number(dto.items[0]!.qtyPlanned)).toBe(7);
    });

    it('отвязка между ранней проверкой версии и UPDATE: upsert получает 409, строки не возвращаются', async () => {
      const { first, shipmentId } = await twoDocShipment('ОУ-5');
      const v = await versionOf(shipmentId);
      const staleForm = asUpsertItems(await itemsOf(shipmentId));

      let locked!: () => void;
      let proceed!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const proceedP = new Promise<void>((r) => (proceed = r));
      const t0 = sql.begin(async (tx) => {
        await tx`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
        locked();
        await proceedP;
        await tx`DELETE FROM shipment_sources WHERE shipment_id = ${shipmentId} AND source_document_id = ${first.id}`;
        await tx`DELETE FROM shipment_items WHERE shipment_id = ${shipmentId} AND source_document_id = ${first.id}`;
        await tx`UPDATE shipments SET version = version + 1 WHERE id = ${shipmentId}`;
      });
      await lockedP;

      const upsertP = save(shipmentId, v, staleForm);
      await waitForLockWaiter('update "shipments"');
      proceed();
      await t0;
      const res = await upsertP;

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: 'conflict', serverVersion: v + 1 });
      const after = await itemsOf(shipmentId);
      expect(after).toHaveLength(1);
      expect(
        after.some((i) => i.source_document_id === first.id || i.source_document_id === null),
      ).toBe(false);
    });
  });

  it('переименование строки отвязанного документа не теряет привязку', async () => {
    // Зеркало приёмки: пока документ привязан, присланное происхождение
    // принимает шаг 3; у отвязанного его отбрасывают намеренно, и строку надо
    // узнать в БД. По id не выйдет (пересоздаются каждым upsert), по названию —
    // тоже, потому что именно его и правят. Остаётся ссылка на позицию.
    const upd = await makeUpd('ОО-20', [{ name: 'плита пкж', qty: '6' }]);
    const shipmentId = await makeShipment();
    expect((await link(shipmentId, upd.id)).statusCode).toBe(200);

    const opened = await itemsOf(shipmentId);
    const staleId = opened[0]!.id;

    const again = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [upd.id],
        items: [{ id: staleId, nameRaw: 'плита пкж', qtyActual: '6', unit: 'шт', lineNo: 1 }],
      }),
    );
    expect(again.statusCode, again.body).toBe(200);
    expect((await itemsOf(shipmentId))[0]!.id).not.toBe(staleId);

    expect((await unlink(shipmentId, upd.id)).statusCode).toBe(200);

    const res = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [],
        items: [
          {
            id: staleId,
            sourceDocumentId: upd.id,
            sourceDocumentItemId: upd.itemIds[0],
            nameRaw: 'Плита ПКЖ 6х1,5',
            qtyActual: '6',
            unit: 'шт',
            lineNo: 1,
          },
        ],
      }),
    );

    expect(res.statusCode, res.body).toBe(200);
    const after = await itemsOf(shipmentId);
    expect(after[0]!.name_raw).toBe('Плита ПКЖ 6х1,5');
    expect(after[0]!.source_document_id).toBe(upd.id);
    expect(after[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('пустое название отклоняется, позиция остаётся прежней', async () => {
    // Портал раньше молча выбрасывал такую строку при сохранении. Инвариант
    // держит контракт: trim().min(1), поэтому и строка из пробелов не проходит.
    const upd = await makeUpd('ОО-21', [{ name: 'Швеллер 16П', qty: '4' }]);
    const shipmentId = await makeShipment();
    expect((await link(shipmentId, upd.id)).statusCode).toBe(200);
    const before = await itemsOf(shipmentId);

    const res = await upsert(
      shipmentBody(shipmentId, {
        sourceDocumentIds: [upd.id],
        items: [{ id: before[0]!.id, nameRaw: '  ', qtyActual: '4', unit: 'шт', lineNo: 1 }],
      }),
    );

    expect(res.statusCode).toBe(400);
    const after = await itemsOf(shipmentId);
    expect(after).toHaveLength(1);
    expect(after[0]!.name_raw).toBe('Швеллер 16П');
    expect(after[0]!.source_document_item_id).toBe(upd.itemIds[0]);
  });

  it('сводка sourceDocuments отдаёт связанные и отвязанные документы', async () => {
    const first = await makeUpd('ОО-8', [{ name: 'Труба 108', qty: '3' }]);
    const second = await makeUpd('ОО-9', [{ name: 'Отвод 108', qty: '6' }]);
    const shipmentId = await makeShipment();
    await link(shipmentId, first.id);
    await link(shipmentId, second.id);
    await unlink(shipmentId, first.id);

    const res = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipmentId}` });
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as {
      sourceDocumentIds: string[];
      sourceDocuments: { id: string; linked: boolean; docNumber: string | null }[];
    };

    expect(dto.sourceDocumentIds).toEqual([second.id]);
    expect(dto.sourceDocuments.map((d) => d.id)).toEqual([second.id, first.id]);
    expect(dto.sourceDocuments.map((d) => d.linked)).toEqual([true, false]);
  });

  it('сводка сверки: одинаковая форма в карточке и в списке (parity)', async () => {
    // Зеркало теста приёмок. Отдельно, а не «по аналогии»: колонки документов в
    // батч-пути отгрузок перечислены своим списком, и разъехаться они могут
    // независимо от приёмок.
    const doc = await makeUpd('О-40', [{ name: 'Кабель', qty: '5' }]);
    const validation = {
      hasMismatch: true,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: 'row_qty_price',
          scope: { row: 1 },
          expected: 1000,
          actual: 10,
          diff: 990,
          tolerance: 1,
          ok: false,
        },
        {
          name: 'items_count',
          scope: 'document',
          expected: 1,
          actual: 1,
          diff: 0,
          tolerance: 0,
          ok: true,
        },
      ],
    };
    await sql`UPDATE source_documents SET validation = ${JSON.stringify(validation)}::jsonb WHERE id = ${doc.id}`;

    const shipmentId = await makeShipment();
    await link(shipmentId, doc.id);

    const single = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipmentId}` });
    expect(single.statusCode, single.body).toBe(200);
    const singleDto = single.json() as { sourceDocuments: { validation?: unknown }[] };
    const v = singleDto.sourceDocuments[0]!.validation as {
      failedChecks: unknown[];
      problemItemIds: string[];
    };
    expect(v.failedChecks).toHaveLength(1);
    expect(v.problemItemIds).toEqual([doc.itemIds[0]]);

    const list = await app.inject({ method: 'GET', url: '/api/v1/shipments?limit=50' });
    const fromList = (
      list.json() as { items: { id: string; sourceDocuments?: unknown[] }[] }
    ).items.find((x) => x.id === shipmentId);
    expect(fromList?.sourceDocuments).toEqual(singleDto.sourceDocuments);
  });
});
