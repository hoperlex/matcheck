/**
 * Проверка ИНН поставщика при распознавании (SUPPLIER_INN_CHECK) — что
 * записывает воркер в настоящую базу.
 *
 * Решатель проверен отдельно (test/supplier-inn-check.test.ts). Здесь —
 * следующий шаг: к какой записи справочника привязан документ, что легло в
 * supplier_inn_raw, след и предупреждение. И главное для выката: off ведёт
 * себя побитово как раньше, а shadow не меняет данных.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../../src/lib/env.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 4 }) : null;

const envState = vi.hoisted(() => ({ mode: 'on' as 'off' | 'shadow' | 'on', sbis: false }));
vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      SUPPLIER_INN_CHECK: envState.mode,
      PARTY_RESOLUTION_V1: 'off',
      EDO_SBIS_ENABLED: envState.sbis,
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
// Без базы набор пропускается, но модуль всё равно импортируется: drizzle(null)
// уронил бы файл на импорте, а не пропустил.
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

/** Корректный десятизначный ИНН из девяти цифр: дописывает контрольную. */
function validInn(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}
/** Тот же ИНН с испорченной контрольной цифрой — ровно одна правка. */
function broken(inn: string): string {
  return inn.slice(0, 9) + ((Number(inn[9]) + 1) % 10);
}

suite('проверка ИНН поставщика: что записывает воркер (реальный PostgreSQL)', () => {
  const db = sql!;
  const siteId = randomUUID();
  const run = String(Date.now()).slice(-6);
  const name = (base: string) => `ООО «${base} ${run}»`;
  const supplierIds: string[] = [];
  const edoAccountId = randomUUID();
  const sbisAccountId = randomUUID();

  beforeAll(async () => {
    await db`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SIC${run.slice(-4)}`}, 'Проверка ИНН')`;
    await db`INSERT INTO edo_accounts (id, name, credentials_encrypted)
             VALUES (${edoAccountId}, ${`Проверка ИНН ${run}`}, ${Buffer.from('x')})`;
    await db`INSERT INTO edo_accounts (id, name, provider, auth_mode, credentials_encrypted)
             VALUES (${sbisAccountId}, ${`Проверка ИНН СБИС ${run}`}, 'sbis', 'sbis_service_key', ${Buffer.from('x')})`;
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db`DELETE FROM edo_export_documents WHERE edo_account_id IN (${edoAccountId}, ${sbisAccountId})`;
    await db`DELETE FROM edo_accounts WHERE id IN (${edoAccountId}, ${sbisAccountId})`;
    await db`DELETE FROM sites WHERE id = ${siteId}`;
    await db.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    await db`DELETE FROM source_document_items WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_document_attachments WHERE source_document_id IN (
      SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await db`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await db`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await db`DELETE FROM suppliers WHERE name LIKE ${`%${run}%`}`;
    if (supplierIds.length > 0) await db`DELETE FROM suppliers WHERE id = ANY(${supplierIds})`;
    supplierIds.length = 0;
  }

  beforeEach(async () => {
    parseUpdPdf.mockReset();
    parseWaybillBatch.mockReset();
    resetSupplierInnCheckCache();
    envState.mode = 'on';
    envState.sbis = false;
    await cleanup();
  });

  async function supplier(inn: string, supplierName: string): Promise<string> {
    const [r] = await db<{ id: string }[]>`
      INSERT INTO suppliers (inn, name) VALUES (${inn}, ${supplierName}) RETURNING id`;
    supplierIds.push(r!.id);
    return r!.id;
  }

  async function seedUpd(): Promise<string> {
    const bundleId = randomUUID();
    const docId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id)
             VALUES (${docId}, 'upd', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId})`;
    return docId;
  }

  function parsedUpd(
    sup: { inn: string | null; name: string },
    over: { docNumber?: string; totalSum?: number } = {},
  ) {
    return {
      parsed: {
        docNumber: over.docNumber ?? `ПИ-${run}`,
        docDate: '2026-10-15',
        totalSum: over.totalSum ?? 1200,
        vatSum: 200,
        itemsCount: 1,
        supplier: { inn: sup.inn, kpp: null, name: sup.name },
        recipient: { inn: '7736255508', kpp: '774550001', name: 'ООО «СУ-10»' },
        consignee: null,
        items: [
          {
            nameRaw: 'Профиль',
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

  async function runUpd(
    sup: { inn: string | null; name: string },
    over: { docNumber?: string; totalSum?: number } = {},
  ) {
    const docId = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd(sup, over));
    await handleJob({
      id: 'j1',
      data: { sourceDocumentId: docId, s3Key: `test/${docId}/source.pdf` },
    } as never);
    return docId;
  }

  type DocRow = {
    status: string;
    parse_error_code: string | null;
    supplier_directory_id: string | null;
    supplier_inn_raw: string | null;
    supplier_inn_check: Record<string, unknown> | null;
    validation: { warnings?: Array<{ name: string }> } | null;
  };
  async function doc(id: string): Promise<DocRow> {
    const [r] = await db<DocRow[]>`
      SELECT status, parse_error_code, supplier_directory_id, supplier_inn_raw, supplier_inn_check, validation
        FROM source_documents WHERE id = ${id}`;
    return r!;
  }
  const warned = (r: DocRow) =>
    (r.validation?.warnings ?? []).some((w) => w.name === 'supplier_inn_unverified');
  async function suppliersNamed(supplierName: string) {
    return db<
      { id: string; inn: string }[]
    >`SELECT id, inn FROM suppliers WHERE name = ${supplierName}`;
  }

  it('on: битый ИНН в одной цифре исправляется по справочнику — правильная запись, без дубля', async () => {
    const inn = validInn(`77${run}1`);
    const target = await supplier(inn, name('Профсталь'));
    const id = await runUpd({ inn: broken(inn), name: name('ПРОФСТАЛЬ') });

    const r = await doc(id);
    expect(r.status).toBe('parsed');
    expect(r.supplier_directory_id).toBe(target);
    expect(r.supplier_inn_raw).toBe(inn);
    expect(r.supplier_inn_check).toMatchObject({
      mode: 'on',
      decision: 'corrected',
      raw: broken(inn),
      inn,
      source: 'directory',
    });
    expect(warned(r)).toBe(false);
    const [n] = await db<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM suppliers WHERE inn = ${broken(inn)}`;
    expect(n!.n).toBe(0);
  });

  it('on: неисправимый ИНН при единственной одноимённой организации — привязка по имени и предупреждение', async () => {
    const inn = validInn(`78${run}2`);
    const target = await supplier(inn, name('Ленинерт'));
    const id = await runUpd({ inn: '1111111111', name: name('ЛЕНИНЕРТ') });

    const r = await doc(id);
    expect(r.supplier_directory_id).toBe(target);
    expect(r.supplier_inn_raw).toBe('1111111111');
    expect(r.supplier_inn_check).toMatchObject({ decision: 'unverified', linkInn: inn });
    expect(warned(r)).toBe(true);
  });

  it('on: неисправимый ИНН без одноимённых — запись без ИНН, повтор находит её же и ловит дубль', async () => {
    const supplierName = name('Неизвестный');
    const first = await runUpd({ inn: '770201001', name: supplierName });
    const r1 = await doc(first);
    expect(r1.supplier_directory_id).not.toBeNull();
    expect(await suppliersNamed(supplierName)).toEqual([{ id: r1.supplier_directory_id, inn: '' }]);
    expect(warned(r1)).toBe(true);

    // Тот же документ ещё раз: опора дедупликации и склейки сегментов —
    // (supplier_directory_id, номер, дата) — обязана совпасть.
    const second = await runUpd({ inn: '770201001', name: supplierName });
    const r2 = await doc(second);
    expect(r2.supplier_directory_id).toBe(r1.supplier_directory_id);
    expect(r2.parse_error_code).toBe('duplicate_upd');
    expect(await suppliersNamed(supplierName)).toHaveLength(1);
  });

  it('on: реестр ЭДО исправляет ИНН, прошедший контрольную сумму по ошибке', async () => {
    const truth = validInn(`50${run}3`);
    const misread = validInn(`50${run.slice(0, 5)}${(Number(run[5]) + 1) % 10}3`);
    await db`INSERT INTO edo_export_documents
               (edo_account_id, message_id, entity_id, document_type, status, document_number,
                document_date, supplier_inn, seller_inns, total_sum)
             VALUES (${edoAccountId}, ${randomUUID()}, ${randomUUID()}, 'UniversalTransferDocument',
                     'not_in_list', ${`ЭД-${run}`}, '2026-10-15', ${truth}, ${[truth]}, 1200)`;
    const id = await runUpd({ inn: misread, name: name('Эдо') }, { docNumber: `ЭД-${run}` });

    const r = await doc(id);
    expect(r.supplier_inn_raw).toBe(truth);
    expect(r.supplier_inn_check).toMatchObject({
      decision: 'corrected',
      source: 'edo',
      raw: misread,
      inn: truth,
    });
    const [s] = await db<
      { inn: string }[]
    >`SELECT inn FROM suppliers WHERE id = ${r.supplier_directory_id!}`;
    expect(s!.inn).toBe(truth);
  });

  it('on: строка реестра из СБИС исправляет ИНН только при включённом EDO_SBIS_ENABLED', async () => {
    const truth = validInn(`51${run}3`);
    const misread = validInn(`51${run.slice(0, 5)}${(Number(run[5]) + 1) % 10}3`);
    for (const suffix of ['1', '2']) {
      await db`INSERT INTO edo_export_documents
                 (edo_account_id, message_id, entity_id, document_type, status, document_number,
                  document_date, supplier_inn, seller_inns, total_sum)
               VALUES (${sbisAccountId}, ${randomUUID()}, ${randomUUID()}, 'УпдСчфДоп',
                       'not_in_list', ${`СБ-${run}${suffix}`}, '2026-10-15', ${truth}, ${[truth]}, 1200)`;
    }
    // Выключен — распознавание строк СБИС не видит, ИНН остаётся прочитанным.
    const off = await doc(await runUpd({ inn: misread, name: name('СБИС выкл') }, { docNumber: `СБ-${run}1` }));
    expect(off.supplier_inn_raw).toBe(misread);
    expect(off.supplier_inn_check).not.toMatchObject({ decision: 'corrected' });

    envState.sbis = true;
    resetSupplierInnCheckCache();
    const on = await doc(await runUpd({ inn: misread, name: name('СБИС вкл') }, { docNumber: `СБ-${run}2` }));
    expect(on.supplier_inn_raw).toBe(truth);
    expect(on.supplier_inn_check).toMatchObject({ decision: 'corrected', source: 'edo', raw: misread, inn: truth });
  });

  it('shadow: данные как при off, след решения записан', async () => {
    const inn = validInn(`77${run}4`);
    await supplier(inn, name('Тень'));
    envState.mode = 'shadow';
    const id = await runUpd({ inn: broken(inn), name: name('ТЕНЬ') });

    const r = await doc(id);
    // Прежнее поведение: битый ИНН заводит свою запись.
    expect(r.supplier_inn_raw).toBe(broken(inn));
    const [s] = await db<
      { inn: string }[]
    >`SELECT inn FROM suppliers WHERE id = ${r.supplier_directory_id!}`;
    expect(s!.inn).toBe(broken(inn));
    supplierIds.push(r.supplier_directory_id!);
    expect(r.supplier_inn_check).toMatchObject({ mode: 'shadow', decision: 'corrected', inn });
    expect(warned(r)).toBe(false);
  });

  it('off: побитово как раньше — следа нет, битый ИНН заводит запись', async () => {
    const inn = validInn(`77${run}5`);
    await supplier(inn, name('Выкл'));
    envState.mode = 'off';
    const id = await runUpd({ inn: broken(inn), name: name('ВЫКЛ') });

    const r = await doc(id);
    expect(r.supplier_inn_check).toBeNull();
    expect(r.supplier_inn_raw).toBe(broken(inn));
    const [s] = await db<
      { inn: string }[]
    >`SELECT inn FROM suppliers WHERE id = ${r.supplier_directory_id!}`;
    expect(s!.inn).toBe(broken(inn));
    supplierIds.push(r.supplier_directory_id!);
    expect(warned(r)).toBe(false);
  });

  it('on: повторный разбор с уже верным ИНН снимает предупреждение', async () => {
    const supplierName = name('Повтор');
    const id = await seedUpd();
    parseUpdPdf.mockResolvedValue(parsedUpd({ inn: '770201001', name: supplierName }));
    await handleJob({
      id: 'j1',
      data: { sourceDocumentId: id, s3Key: `test/${id}/source.pdf` },
    } as never);
    expect(warned(await doc(id))).toBe(true);

    const inn = validInn(`77${run}6`);
    parseUpdPdf.mockResolvedValue(parsedUpd({ inn, name: supplierName }));
    await db`UPDATE source_documents SET status = 'queued' WHERE id = ${id}`;
    await handleJob({
      id: 'j2',
      data: { sourceDocumentId: id, s3Key: `test/${id}/source.pdf` },
    } as never);
    const r = await doc(id);
    expect(r.supplier_inn_check).toMatchObject({ decision: 'valid' });
    expect(warned(r)).toBe(false);
  });

  it('on: накладная с битым ИНН грузоотправителя — исправление и предупреждение у неисправимой', async () => {
    const inn = validInn(`77${run}7`);
    const target = await supplier(inn, name('Грузы'));
    const bundleId = randomUUID();
    const techId = randomUUID();
    await db`INSERT INTO source_bundles (id, site_id, direction, status, bundle_hash, doc_count)
             VALUES (${bundleId}, ${siteId}, 'inbound', 'queued', ${bundleId}, 1)`;
    await db`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, bundle_id, is_technical)
             VALUES (${techId}, 'transport_waybill', 'inbound', 'queued', 'manual_pdf', ${siteId}, ${bundleId}, true)`;
    await db`INSERT INTO source_document_attachments (source_document_id, s3_key, filename, mime_type, size_bytes)
             VALUES (${techId}, ${`test/${techId}/tn.pdf`}, 'tn.pdf', 'application/pdf', 1000)`;
    const waybill = (num: string, shipper: { inn: string; name: string }) => ({
      form: 'tn_2116',
      docNumber: num,
      docDate: '2026-10-15',
      shipper,
      consignee: { inn: '7736255508', name: 'ООО «СУ-10»' },
      items: [{ nameRaw: 'Профиль', qty: 10, unit: 'шт' }],
      confidence: 0.9,
    });
    parseWaybillBatch.mockResolvedValue({
      parsed: {
        documents: [
          waybill(`Т1-${run}`, { inn: broken(inn), name: name('ГРУЗЫ') }),
          waybill(`Т2-${run}`, { inn: '770201001', name: name('Без опоры') }),
        ],
      },
      llmProviderId: null,
    });

    await handleJob({ id: 'j3', data: { bundleId } } as never);

    const rows = await db<(DocRow & { doc_number: string })[]>`
      SELECT doc_number, status, parse_error_code, supplier_directory_id, supplier_inn_raw,
             supplier_inn_check, validation
        FROM source_documents WHERE bundle_id = ${bundleId} AND is_technical = false ORDER BY doc_number`;
    const fixed = rows.find((r) => r.doc_number === `Т1-${run}`)!;
    const unverified = rows.find((r) => r.doc_number === `Т2-${run}`)!;
    expect(fixed.supplier_directory_id).toBe(target);
    expect(fixed.supplier_inn_raw).toBe(inn);
    expect(fixed.validation).toBeNull();
    expect(unverified.supplier_directory_id).not.toBeNull();
    expect(warned(unverified)).toBe(true);
  });
});
