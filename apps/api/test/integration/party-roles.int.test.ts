/**
 * Покупатель совпал с поставщиком (PARTY_ROLES_CHECK) — что записывает воркер
 * в настоящую базу.
 *
 * Решатель проверен отдельно (test/party-roles.test.ts). Здесь — главное для
 * выката:
 *   - у обычных документов on не меняет ничего: проекция значимых полей та
 *     же, что при off;
 *   - shadow не меняет данных и пишет след со сторонами, как их прочла модель;
 *   - on сбрасывает только поля покупателя или ставит пометку, не трогая
 *     видимость на планшете;
 *   - пометка снимается повтором — в том числе при выключенном флаге.
 *
 * История ролей считается по всей таблице, а базу делят все наборы, поэтому
 * имена и ИНН здесь уникальны для прогона.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const envState = vi.hoisted(() => ({ mode: 'off' as 'off' | 'shadow' | 'on' }));
vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      PARTY_ROLES_CHECK: envState.mode,
      SUPPLIER_INN_CHECK: 'off',
      PARTY_RESOLUTION_V1: 'off',
    }),
  };
});
vi.mock('../../src/domain/sse/redis-bridge.js', () => ({
  publishSseEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/instrument.js', () => ({}));
vi.mock('bullmq', () => ({
  Queue: class {
    async add() {
      return { id: 'job-1' };
    }
    async close() {}
  },
  Worker: class {
    on() {}
    async close() {}
  },
}));
vi.mock('../../src/db/client.js', () => ({ db: sql ? drizzle(sql) : {} }));
vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\n%%EOF\n')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presign: vi.fn().mockResolvedValue('https://s3.example/signed'),
}));
const parseUpdPdf = vi.fn();
vi.mock('../../src/domain/edo/upd-pdf.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/upd-pdf.parser.js',
  );
  return { ...actual, parseUpdPdf: (...args: unknown[]) => parseUpdPdf(...args) };
});
const parseWaybillBatch = vi.fn();
vi.mock('../../src/domain/edo/waybill-batch.parser.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/domain/edo/waybill-batch.parser.js',
  );
  return { ...actual, parseWaybillBatch: (...args: unknown[]) => parseWaybillBatch(...args) };
});

const { handleJob } = await import('../../src/worker.js');
const { resetSupplierInnCheckCache } =
  await import('../../src/domain/sourceDocuments/supplier-inn-check.js');
const { mobileVisibleSourceDocumentSql } =
  await import('../../src/domain/sourceDocuments/mobile-visibility.js');
const { sourceDocuments } = await import('../../src/db/schema.js');

/** Корректный десятизначный ИНН из девяти цифр: дописывает контрольную. */
function validInn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}

type Party = { inn: string | null; name: string } | null;

/** Метки времени внутри jsonb (second_pass.requestedAt и т. п.) у двух прогонов разные. */
function withoutTimestamps<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => (/At$/.test(key) ? undefined : v)),
  ) as T;
}

suite('покупатель = поставщик: что записывает воркер (реальный PostgreSQL)', () => {
  const db = sql!;
  const orm = drizzle(db);
  const siteId = randomUUID();
  const run = String(Date.now()).slice(-6);
  const tag = (base: string) => `${base} ${run}`;
  const contractorIds: string[] = [];

  // Организация-поставщик с историей (ИМПЕРИЯ 21544): 6 раз поставщик, 1 раз покупатель.
  const imperiaInn = validInn(`97${run}1`);
  const imperiaName = `ООО «${tag('ИМПЕРИЯ')}»`;
  // Подрядчик из «Контрагентов» (СТРОЙСЕРВИС).
  const contractorInn = validInn(`98${run}2`);
  const contractorName = `ООО «${tag('СТРОЙСЕРВИС')}»`;

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PR${run.slice(-4)}`}, 'Стороны документа')`;
    const [c] = await db<{ id: string }[]>`
      INSERT INTO customer_counterparties (inn, name) VALUES (${contractorInn}, ${contractorName})
      RETURNING id`;
    contractorIds.push(c!.id);
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM customer_counterparties WHERE id = ANY(${contractorIds})`;
    // Операционные контрагенты, заведённые разбором по ИНН этого прогона
    // (СУ-10 общий — его не трогаем).
    await db`DELETE FROM counterparties WHERE inn LIKE ${`9_${run}%`}`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM recognition_evidence_events WHERE bundle_id IN (
      SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await db`DELETE FROM suppliers WHERE name LIKE ${`%${run}%`}`;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseWaybillBatch.mockReset();
    resetSupplierInnCheckCache();
    envState.mode = 'off';
    await cleanup();
  });

  async function seedBundle(): Promise<string> {
    const bundleId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    return bundleId;
  }

  async function seedUpd(): Promise<string> {
    const bundleId = await seedBundle();
    const docId = randomUUID();
    // expected_date — чтобы документ проходил предикат видимости планшета:
    // иначе сравнение видимости off и on было бы пустым (оба «не виден»).
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id, expected_date)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId}, '2026-10-23')`;
    return docId;
  }

  /** История ролей ИМПЕРИИ: 6 документов поставщиком, 1 — покупателем. */
  async function seedImperiaHistory(): Promise<void> {
    const [s] = await db<{ id: string }[]>`
      INSERT INTO suppliers (inn, name) VALUES (${imperiaInn}, ${imperiaName}) RETURNING id`;
    for (let i = 0; i < 6; i++) {
      await db`INSERT INTO source_documents (kind, direction, status, origin, site_id, supplier_directory_id, doc_number)
               VALUES ('upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${s!.id}, ${`H${i}-${run}`})`;
    }
    await db`INSERT INTO source_documents (kind, direction, status, origin, site_id, buyer_inn_raw, buyer_name_raw, doc_number)
             VALUES ('upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${imperiaInn}, ${imperiaName}, ${`HB-${run}`})`;
  }

  function parsedUpd(p: {
    supplier: Party;
    recipient: Party;
    consignee?: Party;
    docNumber?: string;
  }) {
    return {
      parsed: {
        docNumber: p.docNumber ?? `ПР-${run}`,
        docDate: '2026-10-23',
        totalSum: 1200,
        vatSum: 200,
        itemsCount: 1,
        supplier: p.supplier ? { ...p.supplier, kpp: null } : null,
        recipient: p.recipient ? { ...p.recipient, kpp: null } : null,
        consignee: p.consignee ? { ...p.consignee, kpp: null } : null,
        items: [
          {
            nameRaw: 'Витраж',
            qty: 10,
            unit: 'шт',
            price: 100,
            sum: 1000,
            vatRate: 20,
            vatSum: 200,
          },
        ],
        confidence: 0.95,
      },
      textLength: 5000,
      llmProviderId: null,
    };
  }

  async function runUpd(p: Parameters<typeof parsedUpd>[0], docId?: string): Promise<string> {
    const id = docId ?? (await seedUpd());
    parseUpdPdf.mockResolvedValue(parsedUpd(p));
    await handleJob({
      id: 'j1',
      data: { sourceDocumentId: id, s3Key: `test/${id}/source.pdf` },
    } as never);
    return id;
  }

  /** Повторный разбор того же документа: новое поколение, как у «Распознать повторно». */
  async function rerun(docId: string, p: Parameters<typeof parsedUpd>[0]): Promise<void> {
    await db`UPDATE source_documents SET status = 'queued', dispatch_generation = dispatch_generation + 1
             WHERE id = ${docId}`;
    const [g] = await db<
      { g: number }[]
    >`SELECT dispatch_generation AS g FROM source_documents WHERE id = ${docId}`;
    parseUpdPdf.mockResolvedValue(parsedUpd(p));
    await handleJob({
      id: 'j2',
      data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.pdf`, docGeneration: g!.g },
    } as never);
  }

  type DocRow = {
    status: string;
    buyer_id: string | null;
    buyer_name_raw: string | null;
    buyer_inn_raw: string | null;
    recipient_id: string | null;
    consignee_name_raw: string | null;
    validation: { warnings?: Array<{ name: string }> } | null;
  };
  async function doc(id: string): Promise<DocRow> {
    const [r] = await db<DocRow[]>`
      SELECT status, buyer_id, buyer_name_raw, buyer_inn_raw, recipient_id, consignee_name_raw, validation
        FROM source_documents WHERE id = ${id}`;
    return r!;
  }
  const flagged = (r: DocRow) =>
    (r.validation?.warnings ?? []).some((w) => w.name === 'buyer_same_as_supplier');
  async function traces(id: string) {
    return db<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM recognition_evidence_events
       WHERE source_document_id = ${id} AND evidence_type = 'party_roles'`;
  }

  const imperiaDoc = {
    supplier: { inn: null, name: tag('ИМПЕРИЯ') },
    recipient: { inn: null, name: imperiaName },
    consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
  };
  const contractorDoc = {
    supplier: { inn: contractorInn, name: tag('СТРОЙСЕРВИС') },
    recipient: { inn: contractorInn, name: contractorName },
    consignee: { inn: contractorInn, name: contractorName },
  };

  it('off: стороны как прочитаны, следа и пометки нет', async () => {
    await seedImperiaHistory();
    const id = await runUpd(imperiaDoc);
    const r = await doc(id);
    expect(r.buyer_name_raw).toBe(imperiaName);
    expect(flagged(r)).toBe(false);
    expect(await traces(id)).toHaveLength(0);
  });

  it('shadow: данные как при off, в следе — стороны, как их прочла модель, и решение', async () => {
    await seedImperiaHistory();
    envState.mode = 'shadow';
    const id = await runUpd(imperiaDoc);
    const r = await doc(id);
    expect(r.buyer_name_raw).toBe(imperiaName);
    expect(flagged(r)).toBe(false);
    const t = await traces(id);
    expect(t).toHaveLength(1);
    expect(t[0]!.payload).toMatchObject({
      mode: 'shadow',
      decision: { kind: 'drop_buyer' },
      supplier: { name: tag('ИМПЕРИЯ'), inn: null },
      buyer: { name: imperiaName, inn: null },
      stats: { inn: imperiaInn, innSource: 'directory', asSupplier: 6, asBuyerOrConsignee: 1 },
    });
  });

  it('on, 21544: покупатель сброшен, грузополучатель и статус на месте, пометки нет', async () => {
    await seedImperiaHistory();
    const offId = await runUpd(imperiaDoc, undefined);
    const off = await doc(offId);
    await cleanup();
    await seedImperiaHistory();

    envState.mode = 'on';
    const id = await runUpd(imperiaDoc);
    const r = await doc(id);
    expect(r.buyer_name_raw).toBeNull();
    expect(r.buyer_inn_raw).toBeNull();
    expect(r.buyer_id).toBeNull();
    expect(r.recipient_id).toBeNull();
    expect(r.consignee_name_raw).toBe('ООО «СУ-10»');
    expect(r.status).toBe(off.status);
    expect(flagged(r)).toBe(false);
    expect(await traces(id)).toHaveLength(1);
  });

  async function visible(id: string): Promise<boolean> {
    const [v] = await orm
      .select({ visible: drSql<boolean>`${mobileVisibleSourceDocumentSql()}` })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, id));
    return v!.visible;
  }

  it('on, подрядчик: данные не трогаются, пометка; статус и видимость на планшете — как при off', async () => {
    const offId = await runUpd(contractorDoc);
    const off = await doc(offId);
    const offVisible = await visible(offId);
    expect(offVisible).toBe(true);
    await cleanup();

    envState.mode = 'on';
    const id = await runUpd(contractorDoc);
    const r = await doc(id);
    expect(r.buyer_name_raw).toBe(contractorName);
    expect(r.buyer_inn_raw).toBe(contractorInn);
    expect(flagged(r)).toBe(true);
    expect(r.status).toBe(off.status);
    expect(await visible(id)).toBe(offVisible);
  });

  it('пометку снимает повтор без совпадения сторон', async () => {
    envState.mode = 'on';
    const id = await runUpd(contractorDoc);
    expect(flagged(await doc(id))).toBe(true);
    await rerun(id, {
      ...contractorDoc,
      supplier: { inn: validInn(`96${run}3`), name: tag('ДРУГОЙ ПОСТАВЩИК') },
    });
    expect(flagged(await doc(id))).toBe(false);
  });

  it('пометку, поставленную в on, снимает повтор при выключенном флаге', async () => {
    envState.mode = 'on';
    const id = await runUpd(contractorDoc);
    expect(flagged(await doc(id))).toBe(true);
    envState.mode = 'off';
    await rerun(id, contractorDoc);
    expect(flagged(await doc(id))).toBe(false);
  });

  describe('характеризация: у обычных документов on ≡ off', () => {
    const own = { inn: '7736255508', name: 'ООО «СУ-10»' };
    const sup = () => ({ inn: validInn(`95${run}4`), name: tag('ООО «ПОСТАВЩИК»') });
    const buyer = () => ({ inn: validInn(`94${run}5`), name: tag('ООО «ПОКУПАТЕЛЬ»') });
    const cases: Array<[string, () => Parameters<typeof parsedUpd>[0]]> = [
      [
        'обычный УПД с разными сторонами',
        () => ({ supplier: sup(), recipient: buyer(), consignee: buyer() }),
      ],
      ['покупатель — СУ-10', () => ({ supplier: sup(), recipient: own, consignee: own })],
      [
        'грузополучатель «он же»',
        () => ({ supplier: sup(), recipient: buyer(), consignee: { ...buyer() } }),
      ],
      [
        'грузополучатель со скопированным ИНН покупателя',
        () => ({
          supplier: sup(),
          recipient: buyer(),
          consignee: { inn: buyer().inn, name: tag('ООО «ДРУГОЙ»') },
        }),
      ],
      [
        'битый ИНН поставщика',
        () => ({
          supplier: { inn: '5028024698', name: tag('АО «ИСТКУЛЬТ»') },
          recipient: own,
          consignee: own,
        }),
      ],
    ];

    /**
     * Значимые поля документа: без id, времени и служебных счётчиков, ссылки —
     * через то, на что они указывают (записи справочника пересоздаются).
     */
    async function projection(id: string) {
      const [h] = await db<{ head: Record<string, unknown> }[]>`
        SELECT (to_jsonb(d.*) - ARRAY['id','created_at','updated_at','parsed_at','processed_at',
                 'queued_at','version','job_id','job_attempts','bundle_id','supplier_directory_id',
                 'buyer_id','consignee_id','recipient_id','validation']::text[])
               || jsonb_build_object(
                    'validation', d.validation - 'checkedAt',
                    'supplier', (SELECT jsonb_build_object('name', s.name, 'inn', s.inn) FROM suppliers s WHERE s.id = d.supplier_directory_id),
                    'buyer', (SELECT jsonb_build_object('name', c.name, 'inn', c.inn) FROM counterparties c WHERE c.id = d.buyer_id),
                    'consignee', (SELECT jsonb_build_object('name', c.name, 'inn', c.inn) FROM counterparties c WHERE c.id = d.consignee_id),
                    'recipient', (SELECT jsonb_build_object('name', c.name, 'inn', c.inn) FROM counterparties c WHERE c.id = d.recipient_id)
                  ) AS head
          FROM source_documents d WHERE d.id = ${id}`;
      const items = await db<{ item: Record<string, unknown> }[]>`
        SELECT to_jsonb(i.*) - ARRAY['id','source_document_id','created_at','updated_at']::text[] AS item
          FROM source_document_items i WHERE i.source_document_id = ${id} ORDER BY i.line_no`;
      return withoutTimestamps({ head: h!.head, items: items.map((r) => r.item) });
    }

    it.each(cases)('%s', async (_name, build) => {
      envState.mode = 'off';
      const offProjection = await projection(await runUpd(build()));
      await cleanup();
      envState.mode = 'on';
      const onId = await runUpd(build());
      expect(await projection(onId)).toEqual(offProjection);
      expect(await traces(onId)).toHaveLength(0);
    });

    it('накладная', async () => {
      const shipper = { inn: validInn(`93${run}6`), name: tag('ООО «ГРУЗЫ»') };
      async function runWaybill(): Promise<string> {
        const bundleId = await seedBundle();
        const techId = randomUUID();
        await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id, is_technical)
                 VALUES (${techId}, 'transport_waybill', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId}, true)`;
        await db`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, mime_type, size_bytes)
                 VALUES (${techId}, ${`test/${techId}/tn.pdf`}, 'tn.pdf', 'application/pdf', 1000)`;
        parseWaybillBatch.mockResolvedValue({
          parsed: {
            documents: [
              {
                form: 'tn_2116',
                docNumber: `Т-${run}`,
                docDate: '2026-10-23',
                shipper,
                consignee: own,
                items: [{ nameRaw: 'Блоки', qty: 15, unit: 'палет' }],
                confidence: 0.9,
              },
            ],
          },
          llmProviderId: null,
        });
        await handleJob({ id: 'jw', data: { bundleId } } as never);
        const [d] = await db<{ id: string }[]>`
          SELECT id FROM source_documents WHERE bundle_id = ${bundleId} AND is_technical = false`;
        return d!.id;
      }
      envState.mode = 'off';
      const offProjection = await projection(await runWaybill());
      await cleanup();
      envState.mode = 'on';
      expect(await projection(await runWaybill())).toEqual(offProjection);
    });
  });
});
