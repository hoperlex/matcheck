/**
 * Разрешение дубликата и «дополнить» для накладных (реальный PostgreSQL).
 *
 * Главное правило: на планшете не должно быть двух карточек одного документа.
 * «Оставить как новую поставку» снимает с копии пометку дубликата и отправляет
 * её инспектору — поэтому оно разрешено, только когда все документы с тем же
 * ключом (вид, поставщик, номер, дата) уже приняты так, как это понимает
 * планшет: живая приёмка через delivery_sources или живая отгрузка. ЭДО-связь и
 * приёмка в корзине планшету документ не прячут.
 *
 * Плюс гонки: все три действия — одна транзакция с захватом машины и
 * перепроверкой состояния, «оставить» одновременно с «удалить» не должно
 * оставить удалённую копию на планшете или удалить уже оставленную.
 *
 * Набор идёт под GROUPS_ROLLOUT=1 — так на бою с ноября 2026.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));

const PREV_ROLLOUT = process.env.GROUPS_ROLLOUT;
process.env.GROUPS_ROLLOUT = '1';
const { sourceDocumentRoutes } = await import('../../src/routes/source-documents.js');
const { mobileVisibleWithinRolloutSql } = await import(
  '../../src/domain/sourceDocuments/mobile-visibility.js'
);
const { validateUpdTotals } = await import('../../src/domain/edo/upd-validation.js');
const { sourceDocuments } = await import('../../src/db/schema.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('разрешение дубликата и «дополнить» (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let app: FastifyInstance;
  const RUN = randomUUID().slice(0, 8);
  const DOC_NUMBER = `НФНФ-${RUN}`;
  const siteId = randomUUID();
  const userId = randomUUID();
  const supplierDirId = randomUUID();
  const manager = { id: userId, role: 'manager', siteId: null } as unknown as AuthUser;
  let deliveryStatusId = '';
  let shipmentStatusId = '';
  const updParseAdd = vi.fn().mockResolvedValue(undefined);
  const s3CleanupAdd = vi.fn().mockResolvedValue(undefined);

  async function cleanup() {
    await sql`DELETE FROM delivery_edo_matches
               WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_document_visibility_events WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM ingest_events
               WHERE bundle_id IN (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM entity_deletions WHERE site_id = ${siteId}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 10 });
    db = drizzle(sql);
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('queues', {
      updParse: { add: updParseAdd },
      s3Cleanup: { add: s3CleanupAdd },
    } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = manager;
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
    await app.register(sourceDocumentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`DUP${RUN}`}, 'ЖК Дубли')`;
    await sql`INSERT INTO users (id, email, password_hash, role, full_name)
      VALUES (${userId}, ${`dup-${userId}@test`}, 'x', 'manager', 'Иванова Мария')`;
    await sql`INSERT INTO suppliers (id, inn, name) VALUES (${supplierDirId}, '5047141951', 'ООО «Тест-Алюпром»')`;
    const [ds] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [ss] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'draft' LIMIT 1`;
    deliveryStatusId = ds!.id;
    shipmentStatusId = ss!.id;
  });

  afterAll(async () => {
    await app?.close();
    if (PREV_ROLLOUT === undefined) delete process.env.GROUPS_ROLLOUT;
    else process.env.GROUPS_ROLLOUT = PREV_ROLLOUT;
    if (!sql) return;
    await cleanup();
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM suppliers WHERE id = ${supplierDirId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup();
    updParseAdd.mockClear();
    s3CleanupAdd.mockClear();
  });

  type DocOpts = {
    kind?: 'upd' | 'transport_waybill';
    status?: 'parsed' | 'needs_resolution';
    code?: string | null;
    existingId?: string | null;
    items?: number;
    expectedItems?: number | null;
    noValidation?: boolean;
    noKey?: boolean;
    docNumber?: string | null;
    expectedDate?: string;
    bundleId?: string | null;
    withFile?: boolean;
  };

  /**
   * Документ ровно так, как его оставляет воркер (с позициями и сверкой).
   * JSON — строкой с ::jsonb, а не sql.json: drizzle(sql) подменяет
   * сериализаторы у общего клиента, и sql.json после него ломается.
   */
  async function doc(o: DocOpts = {}): Promise<string> {
    const id = randomUUID();
    const n = o.items ?? 3;
    const items = Array.from({ length: n }, (_, i) => ({
      qty: i + 1,
      price: null,
      sum: null,
      vatRate: null,
      vatSum: null,
    }));
    const validation = o.noValidation
      ? null
      : validateUpdTotals({ totalSum: null, vatSum: null, itemsCount: o.expectedItems ?? null, items });
    const docNumber = o.docNumber === undefined ? DOC_NUMBER : o.docNumber;
    const details =
      o.code === 'duplicate_upd'
        ? {
            existingId: o.existingId ?? null,
            docNumber,
            docDate: '2026-11-11',
            duplicateCheck: {
              verdict: 'confirmed',
              detail: `совпали шапка и все позиции (${n})`,
              comparedWith: o.existingId ?? null,
            },
          }
        : o.code === 'partial_parse'
          ? { missing: docNumber ? ['itemsIncomplete'] : ['docNumber'] }
          : null;
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, expected_date, queued_at,
         processed_at, parse_error_code, parse_error_details, supplier_directory_id, doc_number,
         doc_date, validation, llm_confidence, bundle_id, original_filename)
      VALUES (${id}, ${o.kind ?? 'transport_waybill'}, false, 'inbound', 'manual_pdf',
        ${o.status ?? 'parsed'}, ${siteId}, ${o.expectedDate ?? '2026-11-12'}, now(), now(),
        ${o.code ?? null}, ${details ? JSON.stringify(details) : null}::jsonb,
        ${o.noKey ? null : supplierDirId}, ${docNumber}, ${o.noKey ? null : '2026-11-11'},
        ${validation ? JSON.stringify(validation) : null}::jsonb, 0.9, ${o.bundleId ?? null},
        'IMG_0002.pdf')`;
    for (let i = 0; i < n; i++) {
      await sql`INSERT INTO source_document_items (source_document_id, name_raw, qty, unit, line_no)
        VALUES (${id}, ${`AYPC.F50 КС-3П-${i + 1}`}, ${i + 1}, 'шт', ${i + 1})`;
    }
    if (o.withFile) {
      await sql`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, role)
        VALUES (${id}, ${`test/${id}/IMG_0002.pdf`}, 'IMG_0002.pdf', 'original')`;
    }
    return id;
  }

  /** Копия-дубликат: needs_resolution + duplicate_upd, ссылка на найденный. */
  const copyOf = (existingId: string | null, o: DocOpts = {}) =>
    doc({ status: 'needs_resolution', code: 'duplicate_upd', existingId, ...o });

  /** Приёмка, в которой документ принят. */
  async function accept(docId: string, o: { pending?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const pendingAt = o.pending ? new Date().toISOString() : null;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version,
                                      pending_deletion_at, pending_deletion_by_user_id)
      VALUES (${id}, ${siteId}, ${userId}, ${deliveryStatusId}, now(), 1,
              ${pendingAt}, ${o.pending ? userId : null})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docId})`;
    return id;
  }

  /** Машина портала: корневой пакет с событием публичного приёма. */
  async function portalBundle(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_bundles (id, bundle_hash, kind, direction, site_id, status)
      VALUES (${id}, ${randomUUID()}, 'mixed', 'inbound', ${siteId}, 'parsed')`;
    await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
      VALUES (${id}, 'public', ${randomUUID().slice(0, 20)})`;
    return id;
  }

  const resolve = (id: string, action: 'skip' | 'replace' | 'keep', comment?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/source-documents/${id}/resolve-duplicate`,
      payload: { action, ...(comment ? { comment } : {}) },
    });

  async function row(id: string) {
    const [r] = await sql<
      {
        status: string;
        parse_error_code: string | null;
        duplicate_resolution: Record<string, unknown> | null;
        validation: { checks: Array<{ name: string; expected: number | null }> } | null;
      }[]
    >`SELECT status, parse_error_code, duplicate_resolution, validation
        FROM source_documents WHERE id = ${id}`;
    return r ?? null;
  }

  async function visibleOnTablet(id: string): Promise<boolean> {
    const rows = await db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.id, id), mobileVisibleWithinRolloutSql()));
    return rows.length > 0;
  }

  // ─── «Оставить как новую поставку» ──────────────────────────────────────────

  it('оригинал принят → копия оставлена: обработана, видна планшету, след записан', async () => {
    const original = await doc();
    const deliveryId = await accept(original);
    const copy = await copyOf(original);
    expect(await visibleOnTablet(copy)).toBe(false);
    // Как на бою: после разбора у копии уже есть событие «скрыт» (журнал пишет
    // первым только скрытие — появление доставляет дельта по updated_at).
    await sql`INSERT INTO source_document_visibility_events
        (source_document_id, visibility, site_id, reason, created_at)
      VALUES (${copy}, 'hidden', ${siteId}, 'разбор документа завершён', now() - interval '1 minute')`;
    const [before] = await sql<{ updated_at: string }[]>`
      SELECT updated_at::text FROM source_documents WHERE id = ${copy}`;

    const res = await resolve(copy, 'keep', 'вторая машина по той же накладной');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      parseErrorCode: string | null;
      items: unknown[];
      duplicateTrail: {
        resolution: { userName: string | null; comment: string | null; operations: Array<{ id: string }> };
      } | null;
    };
    expect(body.status).toBe('parsed');
    expect(body.parseErrorCode).toBeNull();
    expect(body.items).toHaveLength(3);
    expect(body.duplicateTrail?.resolution.userName).toBe('Иванова Мария');
    expect(body.duplicateTrail?.resolution.comment).toBe('вторая машина по той же накладной');
    expect(body.duplicateTrail?.resolution.operations.map((o) => o.id)).toEqual([deliveryId]);

    const r = await row(copy);
    expect(r?.status).toBe('parsed');
    expect(r?.duplicate_resolution).toMatchObject({ action: 'kept', existingId: original, userId });
    expect(await visibleOnTablet(copy)).toBe(true);
    // Переход видимости записан, а updated_at вырос — планшет заберёт копию
    // дельтой /sync.
    const [ev] = await sql<{ visibility: string }[]>`
      SELECT visibility FROM source_document_visibility_events
       WHERE source_document_id = ${copy}
       ORDER BY created_at DESC, id DESC LIMIT 1`;
    expect(ev?.visibility).toBe('visible');
    const [after] = await sql<{ updated_at: string }[]>`
      SELECT updated_at::text FROM source_documents WHERE id = ${copy}`;
    expect(after!.updated_at > before!.updated_at).toBe(true);

    // Обратная ссылка в карточке оригинала.
    const card = await app.inject({ method: 'GET', url: `/api/v1/source-documents/${original}` });
    const trail = (card.json() as { duplicateTrail: { keptCopies: Array<{ id: string }>; selfAccepted: boolean } })
      .duplicateTrail;
    expect(trail.keptCopies.map((c) => c.id)).toEqual([copy]);
    expect(trail.selfAccepted).toBe(true);
  });

  it('оригинал не принят → отказ: его карточка уже на планшете', async () => {
    const original = await doc();
    const copy = await copyOf(original);
    const res = await resolve(copy, 'keep');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('sibling_not_accepted');
    expect((await row(copy))?.status).toBe('needs_resolution');
    expect((await row(copy))?.parse_error_code).toBe('duplicate_upd');
  });

  it('только ЭДО-связь или приёмка в корзине — не «принят» для планшета', async () => {
    const edoOnly = await doc();
    const edoDelivery = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
      VALUES (${edoDelivery}, ${siteId}, ${userId}, ${deliveryStatusId}, now(), 1)`;
    await sql`INSERT INTO delivery_edo_matches (delivery_id, source_document_id)
      VALUES (${edoDelivery}, ${edoOnly})`;
    const copy1 = await copyOf(edoOnly);
    const r1 = await resolve(copy1, 'keep');
    expect(r1.statusCode).toBe(409);
    expect((r1.json() as { error: string }).error).toBe('sibling_not_accepted');

    await cleanup();
    const inTrash = await doc();
    await accept(inTrash, { pending: true });
    const copy2 = await copyOf(inTrash);
    const r2 = await resolve(copy2, 'keep');
    expect(r2.statusCode).toBe(409);
    expect((r2.json() as { error: string }).error).toBe('sibling_not_accepted');
  });

  it('отгрузка тоже считается приёмом документа', async () => {
    const original = await doc();
    const shipmentId = randomUUID();
    await sql`INSERT INTO shipments (id, status_id, kind, site_id)
      VALUES (${shipmentId}, ${shipmentStatusId}, 'writeoff', ${siteId})`;
    await sql`INSERT INTO shipment_sources (shipment_id, source_document_id)
      VALUES (${shipmentId}, ${original})`;
    const copy = await copyOf(original);
    expect((await resolve(copy, 'keep')).statusCode).toBe(200);
  });

  it('две копии одного принятого оригинала: ни одну не оставить, пока вторая жива', async () => {
    const original = await doc();
    await accept(original);
    const a = await copyOf(original);
    const b = await copyOf(original);

    const ra = await resolve(a, 'keep');
    expect(ra.statusCode).toBe(409);
    expect((ra.json() as { error: string }).error).toBe('sibling_not_accepted');

    // Лишнюю удалили — оставшуюся оставить можно.
    expect((await resolve(b, 'skip')).statusCode).toBe(204);
    expect((await resolve(a, 'keep')).statusCode).toBe(200);
  });

  it('две копии параллельно (10 раундов): ни в одном раунде не появляется видимая копия', async () => {
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const original = await doc();
      await accept(original);
      const a = await copyOf(original);
      const b = await copyOf(original);
      const [ra, rb] = await Promise.all([resolve(a, 'keep'), resolve(b, 'keep')]);
      expect([ra.statusCode, rb.statusCode]).toEqual([409, 409]);
      expect(await visibleOnTablet(a)).toBe(false);
      expect(await visibleOnTablet(b)).toBe(false);
    }
  });

  it('«оставить» одновременно с «удалить» (10 раундов): ровно одно действие, без остатков', async () => {
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const original = await doc();
      await accept(original);
      const copy = await copyOf(original);
      const [rk, rs] = await Promise.all([resolve(copy, 'keep'), resolve(copy, 'skip')]);
      const ok = [rk.statusCode === 200, rs.statusCode === 204].filter(Boolean);
      expect(ok).toHaveLength(1);
      const r = await row(copy);
      if (rk.statusCode === 200) {
        // Оставленная копия не удалена.
        expect(r?.status).toBe('parsed');
        expect([404, 409]).toContain(rs.statusCode);
      } else {
        expect(r).toBeNull();
        expect([404, 409]).toContain(rk.statusCode);
      }
    }
  });

  it('«оставить» одновременно с правкой соседа по машине портала (10 раундов) — без взаимоблокировки', async () => {
    for (let round = 0; round < 10; round++) {
      await cleanup();
      const original = await doc();
      await accept(original);
      const bundleId = await portalBundle();
      const copy = await copyOf(original, { bundleId });
      const neighbour = await doc({ kind: 'upd', docNumber: `СОСЕД-${RUN}`, bundleId });
      const [rk, rp] = await Promise.all([
        resolve(copy, 'keep'),
        app.inject({
          method: 'PATCH',
          url: `/api/v1/source-documents/${neighbour}`,
          payload: { docNumber: `СОСЕД-${RUN}-${round}` },
        }),
      ]);
      expect(rk.statusCode).toBe(200);
      expect(rp.statusCode).toBe(200);
    }
  });

  it('копия в той же машине портала, что и принятый документ, — отказ: планшет спрячет её с машиной', async () => {
    const bundleId = await portalBundle();
    const original = await doc({ bundleId });
    await accept(original);
    const copy = await copyOf(original, { bundleId });
    const res = await resolve(copy, 'keep');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('same_machine');
  });

  it('правка копии не стирает неполный список: «оставить» откажет', async () => {
    const original = await doc();
    await accept(original);
    // По бланку 12 позиций, распознано 3 — исход был бы partial_parse.
    const copy = await copyOf(original, { expectedItems: 12 });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${copy}`,
      payload: {
        items: [
          { nameRaw: 'AYPC.F50 КС-3П-1', qty: 10, unit: 'шт' },
          { nameRaw: 'AYPC.F50 КС-3П-2', qty: 2, unit: 'шт' },
          { nameRaw: 'AYPC.F50 КС-3П-3', qty: 3, unit: 'шт' },
        ],
      },
    });
    expect(patch.statusCode).toBe(200);
    const r = await row(copy);
    // Копия осталась копией, а ожидаемое число позиций — на месте.
    expect(r?.parse_error_code).toBe('duplicate_upd');
    expect(r?.validation?.checks.find((c) => c.name === 'items_count')?.expected).toBe(12);

    const res = await resolve(copy, 'keep');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('incomplete');
  });

  it('оригинал удалён: «оставить» разрешено, «заменить» распознаёт копию заново', async () => {
    const ghost = randomUUID();
    const copy = await copyOf(ghost);
    const info = await app.inject({
      method: 'GET',
      url: `/api/v1/source-documents/${copy}/duplicate-info`,
    });
    expect(info.statusCode).toBe(200);
    const i = info.json() as {
      existingMissing: boolean;
      keep: { allowed: boolean };
      replace: { allowed: boolean };
    };
    expect(i.existingMissing).toBe(true);
    expect(i.keep.allowed).toBe(true);
    expect(i.replace.allowed).toBe(true);

    const copy2 = await copyOf(ghost, { withFile: true, docNumber: `ДРУГОЙ-${RUN}` });
    const rep = await resolve(copy2, 'replace');
    expect(rep.statusCode).toBe(200);
    expect((await row(copy2))?.status).toBe('queued');
    expect(updParseAdd).toHaveBeenCalledTimes(1);

    expect((await resolve(copy, 'keep')).statusCode).toBe(200);
  });

  it('старая копия без сверки или реквизитов: «оставить» нельзя, «удалить» работает', async () => {
    const original = await doc();
    await accept(original);
    const noValidation = await copyOf(original, { noValidation: true });
    const r1 = await resolve(noValidation, 'keep');
    expect(r1.statusCode).toBe(409);
    expect((r1.json() as { error: string }).error).toBe('legacy');
    expect((await resolve(noValidation, 'skip')).statusCode).toBe(204);

    const noKey = await copyOf(original, { noKey: true });
    const r2 = await resolve(noKey, 'keep');
    expect((r2.json() as { error: string }).error).toBe('legacy');
  });

  it('окно и действие не расходятся: allowed совпадает с ответом сервера', async () => {
    const cases: Array<() => Promise<string>> = [
      async () => {
        const o = await doc();
        await accept(o);
        return copyOf(o);
      },
      async () => copyOf(await doc()),
      async () => {
        const o = await doc();
        await accept(o, { pending: true });
        return copyOf(o);
      },
    ];
    for (const make of cases) {
      await cleanup();
      const copy = await make();
      const info = (
        await app.inject({ method: 'GET', url: `/api/v1/source-documents/${copy}/duplicate-info` })
      ).json() as { keep: { allowed: boolean } };
      const res = await resolve(copy, 'keep');
      expect(res.statusCode === 200).toBe(info.keep.allowed);
    }
  });

  it('«заменить» при принятом оригинале — прежний отказ has_references', async () => {
    const original = await doc();
    await accept(original);
    const copy = await copyOf(original, { withFile: true });
    const info = (
      await app.inject({ method: 'GET', url: `/api/v1/source-documents/${copy}/duplicate-info` })
    ).json() as { replace: { allowed: boolean; reason: string | null } };
    expect(info.replace).toEqual({ allowed: false, reason: 'original_used' });
    const res = await resolve(copy, 'replace');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('has_references');
    // Оригинал цел, копия не тронута.
    expect((await row(original))?.status).toBe('parsed');
    expect((await row(copy))?.parse_error_code).toBe('duplicate_upd');
  });

  it('повторное «оставить» — already_resolved', async () => {
    const original = await doc();
    await accept(original);
    const copy = await copyOf(original);
    expect((await resolve(copy, 'keep')).statusCode).toBe(200);
    const again = await resolve(copy, 'keep');
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toBe('already_resolved');
  });

  // ─── «Дополнить» для накладных ──────────────────────────────────────────────

  it('частичная накладная: вписали номер → обработана и видна планшету', async () => {
    const id = await doc({ status: 'needs_resolution', code: 'partial_parse', docNumber: null });
    expect(await visibleOnTablet(id)).toBe(false);
    await sql`INSERT INTO source_document_visibility_events
        (source_document_id, visibility, site_id, reason, created_at)
      VALUES (${id}, 'hidden', ${siteId}, 'разбор документа завершён', now() - interval '1 minute')`;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { docNumber: `НФНФ-${RUN} стр3` },
    });
    expect(res.statusCode).toBe(200);
    const r = await row(id);
    expect(r?.status).toBe('parsed');
    expect(r?.parse_error_code).toBeNull();
    expect(await visibleOnTablet(id)).toBe(true);
    const [ev] = await sql<{ visibility: string }[]>`
      SELECT visibility FROM source_document_visibility_events
       WHERE source_document_id = ${id}
       ORDER BY created_at DESC, id DESC LIMIT 1`;
    expect(ev?.visibility).toBe('visible');
  });

  it('частичная накладная без номера после правки позиций остаётся частичной', async () => {
    const id = await doc({ status: 'needs_resolution', code: 'partial_parse', docNumber: null });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { items: [{ nameRaw: 'AYPC.F50 КР-3П-212', qty: 12, unit: 'шт' }] },
    });
    expect(res.statusCode).toBe(200);
    expect((await row(id))?.parse_error_code).toBe('partial_parse');
  });

  it('частичная накладная с неполным списком: правка количества не делает её обработанной', async () => {
    const id = await doc({
      status: 'needs_resolution',
      code: 'partial_parse',
      items: 20,
      expectedItems: 23,
    });
    const items = Array.from({ length: 20 }, (_, i) => ({
      nameRaw: `AYPC.F50 КС-3П-${i + 1}`,
      qty: i === 0 ? 99 : i + 1,
      unit: 'шт',
    }));
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { items },
    });
    expect(res.statusCode).toBe(200);
    expect((await row(id))?.parse_error_code).toBe('partial_parse');
  });

  it('обработанная накладная без номера: правка позиций её не понижает', async () => {
    const id = await doc({ docNumber: null });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: { items: [{ nameRaw: 'AYPC.F50 КС-3П-1', qty: 5, unit: 'шт' }] },
    });
    expect(res.statusCode).toBe(200);
    const r = await row(id);
    expect(r?.status).toBe('parsed');
    expect(r?.parse_error_code).toBeNull();
  });

  // ─── Анти-регресс ───────────────────────────────────────────────────────────

  it('обычный УПД: PATCH не переносит ожидаемое число позиций (поведение прежнее)', async () => {
    const id = await doc({
      kind: 'upd',
      status: 'needs_resolution',
      code: 'partial_parse',
      expectedItems: 12,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/source-documents/${id}`,
      payload: {
        items: [
          { nameRaw: 'A', qty: 1, unit: 'шт' },
          { nameRaw: 'B', qty: 2, unit: 'шт' },
          { nameRaw: 'C', qty: 3, unit: 'шт' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const r = await row(id);
    expect(r?.validation?.checks.find((c) => c.name === 'items_count')?.expected).toBeNull();
  });

  it('DELETE: с приёмкой — 409, без — удаление и очередь чистки файла', async () => {
    const used = await doc();
    await accept(used);
    const r1 = await app.inject({ method: 'DELETE', url: `/api/v1/source-documents/${used}` });
    expect(r1.statusCode).toBe(409);
    expect((r1.json() as { error: string }).error).toBe('has_references');
    expect(await row(used)).not.toBeNull();

    const free = await doc({ withFile: true });
    const r2 = await app.inject({ method: 'DELETE', url: `/api/v1/source-documents/${free}` });
    expect(r2.statusCode).toBe(200);
    expect(await row(free)).toBeNull();
    expect(s3CleanupAdd).toHaveBeenCalledTimes(1);
    const [del] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM entity_deletions WHERE entity_id = ${free}`;
    expect(del!.n).toBe(1);
  });
});
