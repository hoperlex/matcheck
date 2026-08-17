/**
 * Claim группы и журнал видимости — инварианты схемы.
 *
 * Зачем на уровне БД, а не роутов. Оба механизма защищают от гонки, которую
 * проверкой в коде не удержать: два планшета создают операцию по одной машине
 * одновременно и оба видят её свободной. Гарантию даёт СУБД внутри транзакции
 * создания, поэтому и проверять надо СУБД — тест на роут поймает только тот
 * порядок вызовов, который сам же и задал.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * PRIMARY KEY (operation_kind, group_id) — второй заезд на ту же машину
 *     отбивается, а приёмка и отгрузка одной машины сосуществуют (это разные
 *     операции, обе законны);
 *   * UNIQUE по операции — приёмка не может занять две машины: иначе освободить
 *     их по отдельности стало бы нечем;
 *   * CHECK на соответствие вида и ссылки — claim вида 'delivery' не может
 *     указывать на отгрузку;
 *   * КАСКАД claim'а. Удалили приёмку или пакет — claim обязан уйти следом,
 *     иначе группа заблокирована навсегда, и принять машину больше нельзя;
 *   * ВЫЖИВАНИЕ аудита. События claim и видимости FK НЕ имеют намеренно: вопрос
 *     «кто снял claim» и «почему документ пропал с планшета» задают как раз
 *     после удаления пакета. Каскад стёр бы ответ ровно тогда, когда он нужен.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('claim группы и журнал видимости (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;

  const siteId = randomUUID();
  const statusId = randomUUID();
  const machineA = randomUUID();
  const machineB = randomUUID();
  const deliveryId = randomUUID();
  const otherDeliveryId = randomUUID();
  const shipmentId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`CLM${Date.now() % 10000}`}, 'Claim машины')`;
    // Свой статус: набор делит базу с остальными, а брать первый попавшийся
    // из statuses — значит зависеть от порядка чужих вставок.
    await sql`INSERT INTO statuses (id, entity_type, code, label, sort_order)
              VALUES (${statusId}, 'delivery', ${`clm-${Date.now() % 10000}`}, 'Claim', 999)`;

    await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status, kind)
              VALUES (${machineA}, ${hash('mA')}, 'inbound', ${siteId}, 'parsed', 'mixed'),
                     (${machineB}, ${hash('mB')}, 'inbound', ${siteId}, 'parsed', 'mixed')`;

    await sql`INSERT INTO deliveries (id, site_id, status_id)
              VALUES (${deliveryId}, ${siteId}, ${statusId}),
                     (${otherDeliveryId}, ${siteId}, ${statusId})`;
    await sql`INSERT INTO shipments (id, site_id, status_id, kind)
              VALUES (${shipmentId}, ${siteId}, ${statusId}, 'contractor')`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM operation_group_claim_events WHERE group_id IN (${machineA}, ${machineB})`;
    await sql`DELETE FROM source_document_visibility_events WHERE group_id IN (${machineA}, ${machineB})`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM statuses WHERE id = ${statusId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end();
  });

  it('вторая приёмка той же машины отбивается СУБД, а не проверкой в коде', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
               VALUES ('delivery', ${machineA}, ${deliveryId})`;

      // Второй планшет: другая приёмка, та же машина.
      await expect(
        tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
           VALUES ('delivery', ${machineA}, ${otherDeliveryId})`,
      ).rejects.toThrow(/operation_group_claims_pkey/);

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('приёмка и отгрузка одной машины сосуществуют — это разные операции', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
               VALUES ('delivery', ${machineA}, ${deliveryId})`;
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, shipment_id)
               VALUES ('shipment', ${machineA}, ${shipmentId})`;

      const rows = await tx`SELECT operation_kind FROM operation_group_claims
                             WHERE group_id = ${machineA} ORDER BY operation_kind`;
      expect(rows.map((r) => r.operation_kind)).toEqual(['delivery', 'shipment']);

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('одна приёмка не может занять две машины', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
               VALUES ('delivery', ${machineA}, ${deliveryId})`;

      await expect(
        tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
           VALUES ('delivery', ${machineB}, ${deliveryId})`,
      ).rejects.toThrow(/operation_group_claims_delivery_uniq/);

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('claim вида delivery не может ссылаться на отгрузку', async () => {
    await sql.begin(async (tx) => {
      await expect(
        tx`INSERT INTO operation_group_claims (operation_kind, group_id, shipment_id)
           VALUES ('delivery', ${machineA}, ${shipmentId})`,
      ).rejects.toThrow(/one_operation_check/);

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('удаление приёмки освобождает машину — иначе её больше не принять', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
               VALUES ('delivery', ${machineA}, ${deliveryId})`;
      await tx`DELETE FROM deliveries WHERE id = ${deliveryId}`;

      const left = await tx`SELECT count(*)::int AS n FROM operation_group_claims
                             WHERE group_id = ${machineA}`;
      expect(left[0].n).toBe(0);

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('аудит claim переживает удаление пакета — иначе некому ответить, кто снял', async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO operation_group_claims (operation_kind, group_id, delivery_id)
               VALUES ('delivery', ${machineB}, ${deliveryId})`;
      await tx`INSERT INTO operation_group_claim_events
                 (operation_kind, group_id, operation_id, event, reason)
               VALUES ('delivery', ${machineB}, ${deliveryId}, 'create', 'приёмка создана')`;

      await tx`DELETE FROM source_bundles WHERE id = ${machineB}`;

      const claims = await tx`SELECT count(*)::int AS n FROM operation_group_claims
                               WHERE group_id = ${machineB}`;
      const events = await tx`SELECT count(*)::int AS n FROM operation_group_claim_events
                               WHERE group_id = ${machineB}`;
      expect(claims[0].n).toBe(0); // каскад: группа освобождена
      expect(events[0].n).toBe(1); // аудит цел

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });

  it('события видимости переживают удаление документа', async () => {
    const docId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO source_documents
                 (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
                  doc_number, doc_date, total_sum)
               VALUES (${docId}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
                       'CLM-1', now(), 100)`;
      await tx`INSERT INTO source_document_visibility_events
                 (source_document_id, visibility, site_id, group_id, reason)
               VALUES (${docId}, 'hidden', ${siteId}, ${machineA}, 'переразбор документа')`;

      await tx`DELETE FROM source_documents WHERE id = ${docId}`;

      // Планшет, вернувшийся из офлайна, обязан узнать об исчезновении.
      const events = await tx`SELECT visibility FROM source_document_visibility_events
                               WHERE source_document_id = ${docId}`;
      expect(events).toHaveLength(1);
      expect(events[0].visibility).toBe('hidden');

      throw new Error('rollback');
    }).catch((e) => {
      if (e.message !== 'rollback') throw e;
    });
  });
});
