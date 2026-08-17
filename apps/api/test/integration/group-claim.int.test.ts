/**
 * «Одна машина — одна операция».
 *
 * Проверяется на уровне БД, а не роутов, и это принципиально: гонку двух
 * планшетов невозможно воспроизвести, вызывая обработчики по очереди — тест
 * поймал бы ровно тот порядок, который сам же и задал. Гарантию даёт первичный
 * ключ (operation_kind, group_id): вставка И ЕСТЬ проверка, поэтому проверять
 * надо именно вставку.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * вторая операция на ту же машину получает typed-конфликт, а не 500 и не
 *     молчаливый успех;
 *   * повтор мутации с тем же operationId — успех: планшет переотправляет
 *     запрос после обрыва, и второй ответ обязан совпасть с первым;
 *   * клиент без capability проходит вообще без claim (старые сборки);
 *   * подмножество состава и устаревшая ревизия — РАЗНЫЕ ответы, потому что
 *     клиент реагирует на них по-разному;
 *   * release оставляет след в аудите до того, как строка исчезнет.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const CAPABILITY = 'source_groups_v1';

suite('claim группы: одна машина — одна операция (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  /** Импортируется после подмены env: loadEnv кэширует разбор окружения. */
  let claim: typeof import('../../src/domain/groups/claim.js');

  const siteId = randomUUID();
  const contractorId = randomUUID();
  const contractorInn = `73${String(Date.now()).slice(-8)}`;
  const rootId = randomUUID();
  const docA = randomUUID();
  const docB = randomUUID();
  const deliveryOne = randomUUID();
  const deliveryTwo = randomUUID();
  const shipmentOne = randomUUID();
  let deliveryStatusId: string;
  let shipmentStatusId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;

    process.env.GROUP_MODE_V1 = '1';
    process.env.GROUP_MODE_SITES = siteId;
    vi.resetModules();
    claim = await import('../../src/domain/groups/claim.js');

    const [delStatus] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' ORDER BY sort_order LIMIT 1`;
    const [shipStatus] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' ORDER BY sort_order LIMIT 1`;
    deliveryStatusId = delStatus!.id;
    shipmentStatusId = shipStatus!.id;

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`CL${Date.now() % 100000}`}, 'Claim группы')`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name)
              VALUES (${contractorId}, ${contractorInn}, NULL, 'ООО «Клейм»')`;
    await sql`INSERT INTO source_bundles
        (id, kind, direction, site_id, status, bundle_hash, assembly_version,
         group_revision, published_generation, active_upload_generation)
      VALUES (${rootId}, 'mixed', 'inbound', ${siteId}, 'parsed', ${`cl-${rootId}`}, 'logical_v1',
              7, 0, 0)`;
    for (const [id, num] of [
      [docA, 'CL-A'],
      [docB, 'CL-B'],
    ] as const) {
      await sql`INSERT INTO source_documents
          (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
           doc_number, doc_date, total_sum, expected_date, contractor_id, bundle_id)
        VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
                ${num}, now(), 100, now(), ${contractorId}, ${rootId})`;
    }

    for (const id of [deliveryOne, deliveryTwo]) {
      await sql`INSERT INTO deliveries (id, status_id, site_id, version)
                VALUES (${id}, ${deliveryStatusId}, ${siteId}, 1)`;
    }
    await sql`INSERT INTO shipments (id, status_id, site_id, kind, version)
              VALUES (${shipmentOne}, ${shipmentStatusId}, ${siteId}, 'contractor', 1)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM operation_group_claim_events WHERE group_id = ${rootId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Каждый сценарий начинает с незанятой машины и чистого аудита: и claim, и
    // журнал событий — состояние, и протечка между тестами превратила бы их в
    // проверку порядка запуска.
    await sql`DELETE FROM operation_group_claims WHERE group_id = ${rootId}`;
    await sql`DELETE FROM operation_group_claim_events WHERE group_id = ${rootId}`;
  });

  function enforce(overrides: Partial<Parameters<typeof claim.enforceGroupClaim>[1]> = {}) {
    return claim.enforceGroupClaim(db, {
      operationKind: 'delivery',
      operationId: deliveryOne,
      documentIds: [docA, docB],
      siteId,
      direction: 'inbound',
      capabilities: new Set([CAPABILITY]),
      clientGroupId: rootId,
      clientGroupRevision: 7,
      ...overrides,
    });
  }

  it('вторая операция на ту же машину получает group_claimed', async () => {
    expect(await enforce()).toEqual({ ok: true });

    const second = await enforce({ operationId: deliveryTwo });
    expect('conflict' in second).toBe(true);
    const { conflict } = second as { conflict: Record<string, unknown> };
    expect(conflict.error).toBe('group_claimed');
    expect(conflict.groupId).toBe(rootId);
    // Инспектору нужно показать, кем занята машина, а не «ошибку сервера».
    expect(conflict.claimedByOperationId).toBe(deliveryOne);
    expect(conflict.claimedAt).toBeTruthy();
  });

  it('повтор той же мутации — успех, а не конфликт', async () => {
    expect(await enforce()).toEqual({ ok: true });
    expect(await enforce()).toEqual({ ok: true });

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM operation_group_claims WHERE group_id = ${rootId}`;
    expect(Number(n)).toBe(1);
    // Событие тоже одно: повтор не должен засорять аудит.
    const [{ e }] = await sql<{ e: string }[]>`
      SELECT count(*)::text AS e FROM operation_group_claim_events
       WHERE group_id = ${rootId} AND event = 'create'`;
    expect(Number(e)).toBe(1);
  });

  it('клиент без capability проходит без claim — старые сборки не ломаются', async () => {
    expect(await enforce({ capabilities: new Set() })).toEqual({ ok: true });

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM operation_group_claims WHERE group_id = ${rootId}`;
    expect(Number(n)).toBe(0);
  });

  it('подмножество состава — group_incomplete со списком недостающих', async () => {
    const res = await enforce({ documentIds: [docA] });
    const { conflict } = res as { conflict: Record<string, unknown> };
    expect(conflict.error).toBe('group_incomplete');
    expect(conflict.missingDocumentIds).toEqual([docB]);
    expect(conflict.expectedDocumentIds).toHaveLength(2);
  });

  it('устаревшая ревизия — group_changed, а не «неполный состав»', async () => {
    // Состав тот же, изменились позиции: сравнение множества id этого не ловит,
    // и инспектор подтвердил бы материалы, которых не видел.
    const res = await enforce({ clientGroupRevision: 6 });
    const { conflict } = res as { conflict: Record<string, unknown> };
    expect(conflict.error).toBe('group_changed');
    expect(conflict.groupRevision).toBe(7);
    expect(conflict.expectedDocumentIds).toHaveLength(2);
  });

  it('клиент умеет группы, но прислал догрупповой запрос — group_changed', async () => {
    const res = await enforce({ clientGroupId: null, clientGroupRevision: null });
    const { conflict } = res as { conflict: Record<string, unknown> };
    expect(conflict.error).toBe('group_changed');
  });

  it('машина не готова целиком — source_documents_not_ready', async () => {
    // Один документ уводим в needs_resolution: предикат видимости закрывает всю
    // машину, и принимать нечего.
    await sql`UPDATE source_documents SET status = 'needs_resolution' WHERE id = ${docB}`;
    try {
      const res = await enforce();
      const { conflict } = res as { conflict: Record<string, unknown> };
      expect(conflict.error).toBe('source_documents_not_ready');
    } finally {
      await sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${docB}`;
    }
  });

  it('приёмка и отгрузка одной машины сосуществуют', async () => {
    // Решение по ключу: PK (operation_kind, group_id). Отгрузка не должна
    // натыкаться на claim приёмки — это разные операции, обе законны.
    expect(await enforce()).toEqual({ ok: true });
    const ship = await enforce({
      operationKind: 'shipment',
      operationId: shipmentOne,
      direction: 'inbound',
    });
    expect(ship).toEqual({ ok: true });
  });

  it('release освобождает машину и оставляет след в аудите', async () => {
    expect(await enforce()).toEqual({ ok: true });

    await claim.releaseGroupClaim(db, {
      operationKind: 'delivery',
      operationId: deliveryOne,
      reason: 'приёмка удалена',
    });

    const [{ n }] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM operation_group_claims WHERE group_id = ${rootId}`;
    expect(Number(n)).toBe(0);
    const [ev] = await sql<{ event: string; reason: string | null }[]>`
      SELECT event, reason FROM operation_group_claim_events
       WHERE group_id = ${rootId} AND event = 'release' ORDER BY created_at DESC LIMIT 1`;
    expect(ev?.event).toBe('release');
    expect(ev?.reason).toBe('приёмка удалена');

    // Машина снова свободна — другая операция теперь может её занять.
    expect(await enforce({ operationId: deliveryTwo })).toEqual({ ok: true });
  });
});
