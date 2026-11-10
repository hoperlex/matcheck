/**
 * Импорт договоров 1С и его откат на настоящем PostgreSQL: dry-run не пишет,
 * сверка отпечатка, повторный план пуст, пропавшие договоры не переписывают
 * дату, шлюз массовой пропажи, откат только действующего импорта и только
 * целиком (препятствия — привязка в приёмке, правка после импорта).
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import {
  ContractsImportError,
  readCatalogInfo,
  runContractsImport,
  runContractsRevert,
  type ContractsImportSnapshot,
} from '../../src/domain/supplier-contracts/apply.js';
import type { ParsedContract } from '../../src/domain/supplier-contracts/parse.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function contract(n: number, patch: Partial<ParsedContract> = {}): ParsedContract {
  return {
    rowNo: n + 1,
    onecId: guid(n),
    counterpartyOnecId: null,
    counterpartyName: 'РУТЕК ООО',
    counterpartyInn: '7716951747',
    name: `Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ (ЛОТ 33), ДГ №СУ-ЗИЛ33/25-${n} от 26.08.25`,
    number: `СУ-ЗИЛ33/25-${n}`,
    contractDate: '2025-08-26',
    kind: 'supplier',
    objectText: null,
    ...patch,
  };
}

const META = { fileName: 'test.xlsx', fileSha256: 'x'.repeat(64), rowsTotal: 0 };

suite('импорт договоров 1С', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let statusId: string;
  let siteId: string;
  const createdDeliveries: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    statusId = status!.id;
    const [site] = await sql<{ id: string }[]>`SELECT id FROM sites WHERE code = 'ЗИЛ33'`;
    siteId = site!.id;
  });

  async function clean() {
    await sql`DELETE FROM delivery_contracts`;
    await sql`DELETE FROM delivery_contract_events`;
    await sql`DELETE FROM supplier_contracts`;
    await sql`DELETE FROM supplier_contract_imports`;
  }

  beforeEach(clean);

  afterAll(async () => {
    if (!sql) return;
    await clean();
    await sql`DELETE FROM deliveries WHERE id::text = ANY(string_to_array(${createdDeliveries.join(',')}, ','))`;
    await sql.end({ timeout: 5 });
  });

  async function dryRun(rows: ParsedContract[]) {
    return runContractsImport(db, rows, { ...META, rowsTotal: rows.length }, { apply: false });
  }

  /** dry-run → apply с его отпечатком; снимок возвращается. */
  async function importRows(rows: ParsedContract[], opts: { allowMassMissing?: boolean } = {}) {
    const dry = await dryRun(rows);
    let snapshot: ContractsImportSnapshot | null = null;
    const res = await runContractsImport(
      db,
      rows,
      { ...META, rowsTotal: rows.length },
      {
        apply: true,
        confirm: dry.plan.fingerprint.slice(0, 16),
        allowMassMissing: opts.allowMassMissing,
        beforeWrite: (s) => {
          snapshot = s;
        },
      },
    );
    return { res, snapshot: snapshot as ContractsImportSnapshot | null };
  }

  const contractRow = async (onecId: string) =>
    (
      await sql<{ id: string; name: string; missing_since: string | null; site_status: string }[]>`
        SELECT id, name, to_char(missing_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS missing_since,
               site_status
        FROM supplier_contracts WHERE onec_id = ${onecId}`
    )[0];

  async function linkDelivery(contractOnecId: string): Promise<string> {
    const id = randomUUID();
    createdDeliveries.push(id);
    await sql`INSERT INTO deliveries (id, site_id, status_id) VALUES (${id}, ${siteId}, ${statusId})`;
    const c = await contractRow(contractOnecId);
    await sql`INSERT INTO delivery_contracts (delivery_id, contract_id) VALUES (${id}, ${c!.id})`;
    return id;
  }

  it('dry-run ничего не пишет; apply с верным отпечатком пишет; повторный план пуст', async () => {
    const rows = [contract(1), contract(2)];
    const dry = await dryRun(rows);
    expect(dry.applied).toBe(false);
    expect(dry.plan.inserts).toHaveLength(2);
    expect((await sql`SELECT count(*)::int AS n FROM supplier_contracts`)[0]!.n).toBe(0);

    const { res, snapshot } = await importRows(rows);
    expect(res.applied).toBe(true);
    expect(snapshot?.inserts).toHaveLength(2);
    const c = await contractRow(guid(1));
    expect(c).toMatchObject({ site_status: 'exact', missing_since: null });
    const site = await sql<{ ok: boolean }[]>`
      SELECT ${siteId}::uuid = ANY(site_ids) AS ok FROM supplier_contracts WHERE onec_id = ${guid(1)}`;
    expect(site[0]!.ok).toBe(true);

    expect((await dryRun(rows)).plan.opCount).toBe(0);
    const info = await readCatalogInfo(db);
    expect(info).toEqual({ total: 2, importedAt: snapshot!.appliedAt });
  });

  it('неверный --confirm — отказ, ничего не записано', async () => {
    await expect(
      runContractsImport(db, [contract(1)], META, { apply: true, confirm: '0123456789abcdef' }),
    ).rejects.toMatchObject({ code: 'fingerprint' });
    expect((await sql`SELECT count(*)::int AS n FROM supplier_contracts`)[0]!.n).toBe(0);
  });

  it('повторный импорт файла без договора X: дата пропажи ставится один раз, потом X возвращается', async () => {
    const rows = [contract(1), contract(2), contract(3), contract(4), contract(5), contract(6)];
    await importRows(rows);
    const withoutX = rows.filter((r) => r.onecId !== guid(6));

    const { snapshot: s2 } = await importRows(withoutX);
    const x1 = await contractRow(guid(6));
    expect(x1!.missing_since).toBe(s2!.appliedAt);
    expect((await dryRun(withoutX)).plan.opCount).toBe(0);

    // Второй apply того же файла: изменений нет, дата прежняя.
    const again = await runContractsImport(db, withoutX, META, {
      apply: true,
      confirm: (await dryRun(withoutX)).plan.fingerprint.slice(0, 16),
    });
    expect(again.applied).toBe(false);
    expect((await contractRow(guid(6)))!.missing_since).toBe(s2!.appliedAt);

    // X снова в файле — returned.
    const dry = await dryRun(rows);
    expect(dry.plan.returned).toBe(1);
    await importRows(rows);
    expect((await contractRow(guid(6)))!.missing_since).toBeNull();
  });

  it('привязанный договор пропал из выгрузки — остаётся и попадает в «Затронутые привязки»', async () => {
    const rows = [contract(1), contract(2), contract(3), contract(4), contract(5), contract(6)];
    await importRows(rows);
    const deliveryId = await linkDelivery(guid(6));
    const dry = await dryRun(rows.slice(0, 5));
    expect(dry.plan.affectedLinks).toEqual([expect.objectContaining({ reason: 'missing' })]);
    await importRows(rows.slice(0, 5));
    const link = await sql`SELECT 1 FROM delivery_contracts WHERE delivery_id = ${deliveryId}`;
    expect(link).toHaveLength(1);
  });

  it('шлюз массовой пропажи: без флага — отказ, с флагом — запись', async () => {
    const rows = [contract(1), contract(2), contract(3), contract(4)];
    await importRows(rows);
    const rest = rows.slice(0, 1);
    const dry = await dryRun(rest);
    expect(dry.plan.massMissing).toBe(true);
    await expect(
      runContractsImport(db, rest, META, { apply: true, confirm: dry.plan.fingerprint.slice(0, 16) }),
    ).rejects.toMatchObject({ code: 'mass_missing' });
    const { res } = await importRows(rest, { allowMassMissing: true });
    expect(res.applied).toBe(true);
  });

  describe('откат', () => {
    it('A вставил X, B обновил X: откат A отклонён; откат B, затем A — X удалён', async () => {
      const { snapshot: a } = await importRows([contract(1)]);
      const { snapshot: b } = await importRows([contract(1, { name: 'Новое имя ЛОТ 33' })]);
      expect((await contractRow(guid(1)))!.name).toBe('Новое имя ЛОТ 33');

      await expect(runContractsRevert(db, a!, { apply: false })).rejects.toMatchObject({ code: 'not_latest' });

      const dryB = await runContractsRevert(db, b!, { apply: false });
      expect(dryB.obstacles).toEqual([]);
      await runContractsRevert(db, b!, { apply: true, confirm: dryB.fingerprint.slice(0, 16) });
      expect((await contractRow(guid(1)))!.name).toBe(contract(1).name);

      const dryA = await runContractsRevert(db, a!, { apply: false });
      await runContractsRevert(db, a!, { apply: true, confirm: dryA.fingerprint.slice(0, 16) });
      expect(await contractRow(guid(1))).toBeUndefined();
      expect(await readCatalogInfo(db)).toEqual({ total: 0, importedAt: null });
    });

    it('договор из импорта выбран в приёмке — откат целиком не выполняется', async () => {
      const { snapshot } = await importRows([contract(1), contract(2)]);
      await linkDelivery(guid(2));
      const dry = await runContractsRevert(db, snapshot!, { apply: false });
      expect(dry.obstacles).toEqual([expect.objectContaining({ reason: 'linked', onecId: guid(2) })]);
      await expect(
        runContractsRevert(db, snapshot!, { apply: true, confirm: dry.fingerprint.slice(0, 16) }),
      ).rejects.toMatchObject({ code: 'obstacles' });
      // Ничего не тронуто: оба договора на месте, импорт не помечен откатанным.
      expect((await sql`SELECT count(*)::int AS n FROM supplier_contracts`)[0]!.n).toBe(2);
      const imp = await sql`SELECT reverted_at FROM supplier_contract_imports WHERE id = ${snapshot!.importId}`;
      expect(imp[0]!.reverted_at).toBeNull();
    });

    it('строка изменилась после импорта — препятствие, ничего не тронуто', async () => {
      await importRows([contract(1), contract(2)]);
      const { snapshot } = await importRows([contract(1, { name: 'Другое имя ЛОТ 33' }), contract(2)]);
      await sql`UPDATE supplier_contracts SET name = 'правка руками' WHERE onec_id = ${guid(1)}`;
      const dry = await runContractsRevert(db, snapshot!, { apply: false });
      expect(dry.obstacles).toEqual([expect.objectContaining({ reason: 'changed_after_import', onecId: guid(1) })]);
      await expect(
        runContractsRevert(db, snapshot!, { apply: true, confirm: dry.fingerprint.slice(0, 16) }),
      ).rejects.toMatchObject({ code: 'obstacles' });
      expect((await contractRow(guid(1)))!.name).toBe('правка руками');
    });

    it('откат возвращает дату пропажи: и поставленную, и снятую', async () => {
      const rows = [contract(1), contract(2), contract(3), contract(4), contract(5)];
      await importRows(rows);
      const { snapshot: gone } = await importRows(rows.slice(0, 4));
      const goneAt = (await contractRow(guid(5)))!.missing_since;
      expect(goneAt).toBe(gone!.appliedAt);

      const { snapshot: back } = await importRows(rows);
      expect((await contractRow(guid(5)))!.missing_since).toBeNull();
      const dryBack = await runContractsRevert(db, back!, { apply: false });
      await runContractsRevert(db, back!, { apply: true, confirm: dryBack.fingerprint.slice(0, 16) });
      expect((await contractRow(guid(5)))!.missing_since).toBe(goneAt);

      const dryGone = await runContractsRevert(db, gone!, { apply: false });
      await runContractsRevert(db, gone!, { apply: true, confirm: dryGone.fingerprint.slice(0, 16) });
      expect((await contractRow(guid(5)))!.missing_since).toBeNull();
    });

    it('снимок неприменённого apply и повторный откат — отказ', async () => {
      const { snapshot } = await importRows([contract(1)]);
      const fake = { ...snapshot!, importId: randomUUID() };
      await expect(runContractsRevert(db, fake, { apply: false })).rejects.toMatchObject({ code: 'not_applied' });

      const dry = await runContractsRevert(db, snapshot!, { apply: false });
      await runContractsRevert(db, snapshot!, { apply: true, confirm: dry.fingerprint.slice(0, 16) });
      await expect(runContractsRevert(db, snapshot!, { apply: false })).rejects.toBeInstanceOf(
        ContractsImportError,
      );
      await expect(runContractsRevert(db, snapshot!, { apply: false })).rejects.toMatchObject({
        code: 'already_reverted',
      });
    });
  });
});
