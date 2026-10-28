/**
 * Импорт справочников (поставщики BillHub, подрядчики 1С, склейка дублей) — на
 * настоящем PostgreSQL. Проверяется то, что нельзя доказать чтением кода:
 *   - dry-run ничего не пишет;
 *   - apply меняет только нужное, перепривязывает документы склеенных дублей
 *     без потерь, сигналит планшету только в окне синхронизации;
 *   - повтор ничего не меняет;
 *   - воркер, стоящий на создании поставщика с тем же ИНН, не создаёт дубль;
 *   - документ, привязываемый к дублю в момент импорта, попадает и в
 *     перепривязку, и в снимок отката;
 *   - чужая блокировка → понятная ошибка, ничего не записано;
 *   - откат по снимку возвращает как было;
 *   - склейка без файлов (--merges-only, --near-inn, --pairs): тот же путь
 *     записи и отката, повтор пуст.
 *
 * Склейка работает по всей таблице suppliers, поэтому набор НЕ трогает общую
 * тестовую базу: на сервере TEST_DATABASE_URL создаётся своя база, на неё
 * накатываются миграции, в конце база удаляется.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import {
  DirectoriesImportError,
  runDirectoriesImport,
  type ImportSnapshot,
} from '../../src/domain/directories/apply.js';
import { extractBracketInn } from '../../src/domain/directories/names.js';
import type { BillhubSupplier, OneCContractor } from '../../src/domain/directories/parse.js';
import type { DirectoriesInput } from '../../src/domain/directories/plan.js';
import { revertDirectoriesImport } from '../../src/domain/directories/revert.js';
import { matchOrCreateSupplier } from '../../src/domain/sourceDocuments/supplierMatcher.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

// Корректные ИНН (контрольная сумма сходится).
const INN = {
  plastko: '7704602692',
  inoks: '5906154545',
  paritet: '7733896430',
  elteh: '7842224734',
  leninert: '7816583913',
  race: '7716203621',
  vist: '7706752171',
};

type Sql = ReturnType<typeof postgres>;

/** timestamptz из сырого запроса: драйвер отдаёт Date или строку. */
const ms = (v: unknown) => new Date(v as string | Date).getTime();
const iso = (v: unknown) => new Date(v as string | Date).toISOString();

suite('импорт справочников на PostgreSQL', () => {
  const dbName = `matcheck_dir_import_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  let sql2: Sql;
  let db: Db;
  let db2: Db;
  const siteId = randomUUID();

  beforeAll(async () => {
    admin = postgres(TEST_DATABASE_URL!, { max: 1 });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    execFileSync('node_modules/.bin/tsx', ['scripts/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'ignore',
    });
    sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
    sql2 = postgres(url.toString(), { max: 2, onnotice: () => {} });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    db2 = drizzle(sql2, { schema, casing: 'snake_case' }) as unknown as Db;
    await sql`insert into sites (id, code, name) values (${siteId}, 'DIR', 'Импорт справочников')`;
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await sql2?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Сид 0055 и данные прошлых тестов не нужны: склейка смотрит на всю таблицу.
    await sql`delete from source_documents`;
    await sql`update users set contractor_customer_id = null`;
    await sql`delete from suppliers`;
    await sql`delete from customer_counterparties`;
  });

  async function supplier(p: {
    id?: string;
    name: string;
    inn: string;
    billhubId?: string | null;
  }) {
    const id = p.id ?? randomUUID();
    await sql`insert into suppliers (id, inn, name, billhub_id, created_at, updated_at)
              values (${id}, ${p.inn}, ${p.name}, ${p.billhubId ?? null},
                      '2026-08-20T10:00:00Z', '2026-08-20T10:00:00Z')`;
    return id;
  }

  async function doc(supplierId: string, updatedAt = new Date()) {
    const id = randomUUID();
    await sql`insert into source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 supplier_directory_id, updated_at)
              values (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId},
                      ${`D-${id.slice(0, 8)}`}, '2026-08-01', 100.00, ${supplierId}, ${updatedAt.toISOString()})`;
    return id;
  }

  function hub(p: Partial<BillhubSupplier> & { name: string; innRaw: string }): BillhubSupplier {
    return {
      rowNo: 2,
      id: randomUUID(),
      aliases: [],
      securityStatus: null,
      comment: null,
      createdAt: new Date('2026-03-17T15:27:00Z'),
      ...p,
    };
  }

  function oneC(raw: string): OneCContractor {
    const b = extractBracketInn(raw);
    return { raw, base: b.base, inn: b.inn, rowNos: [1], projects: [] };
  }

  async function snapshotTables() {
    return {
      suppliers: await sql`select * from suppliers order by id`,
      cc: await sql`select * from customer_counterparties order by id`,
      docs: await sql`select id, supplier_directory_id, updated_at from source_documents order by id`,
    };
  }

  /** Типовой набор: сид, обогащение по ИНН, новая строка-цель склейки, авто-склейка, сомнительное. */
  async function fixture() {
    const seedId = await supplier({ name: 'ОО "Пластко"', inn: INN.plastko });
    const auto = await supplier({
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТРУППА КОМПАНИЙ "ИНОКС"',
      inn: INN.inoks,
    });
    const autoDocRecent = await doc(auto);
    const autoDocOld = await doc(auto, new Date(Date.now() - 200 * 24 * 3600 * 1000));
    const paritetBroken = await supplier({ name: 'ООО «Паритет»', inn: '773896430' });
    const paritetDoc = await doc(paritetBroken);
    const elteh = await supplier({ name: 'АО "ТД "ЭЛЕКТРОТЕХМОНТАЖ"', inn: INN.elteh });
    const eltehBroken = await supplier({ name: 'ТД Электротехмонтаж', inn: '784224734' });
    const eltehDocs = [await doc(eltehBroken), await doc(eltehBroken)];
    const leninert = await supplier({ name: 'ООО "ЛЕНИНЕРТ"', inn: INN.leninert });
    const leninertEmpty = await supplier({ name: 'Ленинерт', inn: '' });

    const gorizont = randomUUID();
    const porunov = randomUUID();
    await sql`insert into customer_counterparties (id, inn, name) values
                (${gorizont}, '7723430488', 'ООО «СК Горизонт»'),
                (${porunov}, '524310784550', 'ИП Порунов А.В.')`;

    const paritetHub = hub({
      name: 'ООО "ПАРИТЕТ"',
      innRaw: INN.paritet,
      securityStatus: 'approved',
    });
    const inoksHub = hub({
      name: '"Группа Компаний "ИНОКС"',
      innRaw: INN.inoks,
      comment: 'полный комплект',
    });
    const input: DirectoriesInput = {
      suppliers: [
        hub({ id: seedId, name: 'ОО "Пластко"', innRaw: INN.plastko, securityStatus: 'approved' }),
        inoksHub,
        paritetHub,
      ],
      contractors: [oneC('ГОРИЗОНТ СК ООО'), oneC('ЭСКО ООО'), oneC('Порунов Артём Владимирович')],
    };
    return {
      input,
      seedId,
      auto,
      autoDocRecent,
      autoDocOld,
      paritetBroken,
      paritetDoc,
      paritetHub,
      inoksHub,
      elteh,
      eltehBroken,
      eltehDocs,
      leninert,
      leninertEmpty,
      gorizont,
      porunov,
    };
  }

  async function applyWithConfirm(
    input: DirectoriesInput,
    extra: Parameters<typeof runDirectoriesImport>[2] = { apply: true },
  ) {
    const dry = await runDirectoriesImport(db, input, { apply: false });
    return runDirectoriesImport(db, input, {
      ...extra,
      apply: true,
      confirm: dry.plan.fingerprint.slice(0, 16),
    });
  }

  it('dry-run ничего не пишет', async () => {
    const f = await fixture();
    const before = await snapshotTables();
    const dry = await runDirectoriesImport(db, f.input, { apply: false });
    expect(dry.plan.opCount).toBeGreaterThan(0);
    expect(await snapshotTables()).toEqual(before);
  });

  it('apply: импорт, склейка, сигнал планшету; повтор — пусто', async () => {
    const f = await fixture();
    const before = await snapshotTables();
    const started = Date.now();
    let snapshot: ImportSnapshot | null = null;
    const r = await applyWithConfirm(f.input, {
      apply: true,
      beforeWrite: async (s) => {
        snapshot = s;
      },
    });
    expect(r.applied).toBe(true);

    const rows = new Map((await sql`select * from suppliers`).map((s) => [s.id as string, s]));
    // Сид: billhub_id, опечатка формы, статус; created_at не тронут.
    const seed = rows.get(f.seedId)!;
    expect(seed).toMatchObject({
      billhub_id: f.seedId,
      name: 'ООО "Пластко"',
      last_security_status: 'approved',
    });
    expect(iso(seed.created_at)).toBe('2026-08-20T10:00:00.000Z');
    // Обогащение: id тот же, имя BillHub, старое — алиасом, документы на месте.
    expect(rows.get(f.auto)).toMatchObject({
      billhub_id: f.inoksHub.id,
      name: '"Группа Компаний "ИНОКС"',
      aliases: ['ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТРУППА КОМПАНИЙ "ИНОКС"'],
      inn: INN.inoks,
      founding_documents_comment: 'полный комплект',
    });
    // Новая строка BillHub стала целью склейки битого «Паритета».
    expect(rows.get(f.paritetHub.id)).toMatchObject({
      billhub_id: f.paritetHub.id,
      inn: INN.paritet,
    });
    expect(iso(rows.get(f.paritetHub.id)!.created_at)).toBe('2026-03-17T15:27:00.000Z');
    expect(rows.has(f.paritetBroken)).toBe(false);
    // Автоцель (не из файла) приняла битый дубль.
    expect(rows.has(f.eltehBroken)).toBe(false);
    expect(rows.get(f.elteh)!.aliases).toEqual(['ТД Электротехмонтаж']);
    // Сомнительное (пустой ИНН) не тронуто — вплоть до updated_at.
    for (const id of [f.leninert, f.leninertEmpty]) {
      expect(rows.get(id)).toEqual(before.suppliers.find((s) => s.id === id));
    }

    const docs = new Map(
      (await sql`select id, supplier_directory_id, updated_at from source_documents`).map((d) => [
        d.id as string,
        d,
      ]),
    );
    expect(docs.get(f.paritetDoc)!.supplier_directory_id).toBe(f.paritetHub.id);
    for (const id of f.eltehDocs) expect(docs.get(id)!.supplier_directory_id).toBe(f.elteh);
    expect(docs.get(f.autoDocRecent)!.supplier_directory_id).toBe(f.auto);
    expect([...docs.values()].filter((d) => d.supplier_directory_id === null)).toEqual([]);
    // Сигнал планшету — только в окне 90 дней.
    expect(ms(docs.get(f.autoDocRecent)!.updated_at)).toBeGreaterThanOrEqual(started);
    expect(ms(docs.get(f.eltehDocs[0]!)!.updated_at)).toBeGreaterThanOrEqual(started);
    const oldBefore = before.docs.find((d) => d.id === f.autoDocOld)!.updated_at;
    expect(ms(docs.get(f.autoDocOld)!.updated_at)).toBe(ms(oldBefore));

    const cc = new Map(
      (await sql`select * from customer_counterparties`).map((c) => [c.name as string, c]),
    );
    expect(cc.get('ООО «СК Горизонт»')!.aliases).toEqual(['ГОРИЗОНТ СК ООО']);
    expect(cc.get('ООО "ЭСКО"')).toMatchObject({ inn: '', aliases: ['ЭСКО ООО'] });
    expect(cc.get('ИП Порунов А.В.')!.aliases).toEqual([]);
    expect(cc.has('Порунов Артём Владимирович')).toBe(false);

    const snap = snapshot as ImportSnapshot | null;
    expect(snap?.merges.flatMap((m) => m.sources.flatMap((s) => s.docIds)).sort()).toEqual(
      [f.paritetDoc, ...f.eltehDocs].sort(),
    );

    const again = await runDirectoriesImport(db, f.input, { apply: false });
    expect(again.plan.opCount).toBe(0);
  });

  it('гонка: воркер, ждущий создания поставщика с тем же ИНН, не создаёт дубль', async () => {
    const newHub = hub({ name: 'ООО "ВИСТ"', innRaw: INN.race });
    const input: DirectoriesInput = { suppliers: [newHub] };
    const pending: { matcher?: ReturnType<typeof matchOrCreateSupplier> } = {};
    await applyWithConfirm(input, {
      apply: true,
      afterLock: async () => {
        // Без await: импорт держит advisory-ключ этого ИНН, матчер обязан ждать.
        pending.matcher = matchOrCreateSupplier(
          { db: db2 },
          { inn: INN.race, kpp: null, name: 'ООО Гонка Распознавания' },
        );
        for (let i = 0; i < 100; i++) {
          const [w] =
            await sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
          if ((w!.n as number) > 0) return;
          await new Promise((res) => setTimeout(res, 20));
        }
        throw new Error('матчер не встал на блокировку');
      },
    });
    const match = await pending.matcher;
    expect(match).toMatchObject({ id: newHub.id, source: 'inn' });
    const [n] = await sql`select count(*)::int as n from suppliers where inn = ${INN.race}`;
    expect(n!.n).toBe(1);
  });

  it('документ, привязываемый к дублю во время импорта, попадает в снимок и в перепривязку', async () => {
    const target = await supplier({ name: 'ООО "ВИСТ"', inn: INN.vist, billhubId: randomUUID() });
    const broken = await supplier({ name: 'ВИСТ', inn: '7706752172' });
    const late = randomUUID();
    let snapshot: ImportSnapshot | null = null;
    const pending: { commit?: Promise<unknown> } = {};
    await applyWithConfirm(
      { suppliers: [] },
      {
        apply: true,
        afterLock: async () => {
          let inserted!: () => void;
          const ready = new Promise<void>((res) => (inserted = res));
          // Вставка держит KEY SHARE на дубле и коммитится позже — FOR UPDATE
          // импорта обязан её дождаться.
          pending.commit = sql2.begin(async (t) => {
            await t`insert into source_documents
                      (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                       supplier_directory_id)
                    values (${late}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, 'LATE', '2026-08-01',
                            1.00, ${broken})`;
            inserted();
            await new Promise((res) => setTimeout(res, 300));
          });
          await ready;
        },
        beforeWrite: async (s) => {
          snapshot = s;
        },
      },
    );
    await pending.commit;
    const snap = snapshot as ImportSnapshot | null;
    expect(snap?.merges[0]?.sources[0]?.docIds).toEqual([late]);
    const [d] = await sql`select supplier_directory_id from source_documents where id = ${late}`;
    expect(d!.supplier_directory_id).toBe(target);
  });

  it('чужая блокировка: понятная ошибка, ничего не записано', async () => {
    const f = await fixture();
    const before = await snapshotTables();
    const dry = await runDirectoriesImport(db, f.input, { apply: false });
    let release!: () => void;
    const hold = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const isLocked = new Promise<void>((res) => (locked = res));
    const holder = sql2.begin(async (t) => {
      await t`lock table suppliers in row exclusive mode`;
      locked();
      await hold;
    });
    await isLocked;
    try {
      const err = (await runDirectoriesImport(db, f.input, {
        apply: true,
        confirm: dry.plan.fingerprint.slice(0, 16),
        lockTimeoutMs: 200,
      }).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: string; cause?: { code?: string } } | null;
      // 55P03 — lock_not_available; drizzle может завернуть ошибку драйвера в cause.
      expect(err?.code ?? err?.cause?.code).toBe('55P03');
    } finally {
      release();
      await holder;
    }
    expect(await snapshotTables()).toEqual(before);
  });

  it('план изменился после dry-run — откат, ничего не записано', async () => {
    const f = await fixture();
    const before = await snapshotTables();
    await expect(
      runDirectoriesImport(db, f.input, { apply: true, confirm: '0000000000000000' }),
    ).rejects.toBeInstanceOf(DirectoriesImportError);
    expect(await snapshotTables()).toEqual(before);
  });

  it('откат по снимку возвращает справочники и связи документов', async () => {
    const f = await fixture();
    const before = await snapshotTables();
    let snapshot: ImportSnapshot | null = null;
    await applyWithConfirm(f.input, {
      apply: true,
      beforeWrite: async (s) => {
        snapshot = s;
      },
    });
    const dry = await revertDirectoriesImport(db, snapshot!, { apply: false });
    expect(dry.plan.supplierConflicts).toEqual([]);
    const r = await revertDirectoriesImport(db, snapshot!, { apply: true });
    expect(r.plan.supplierKept).toEqual([]);

    const strip = (rows: postgres.Row[]) => rows.map(({ updated_at: _u, ...rest }) => rest);
    const after = await snapshotTables();
    expect(strip(after.suppliers)).toEqual(strip(before.suppliers));
    expect(strip(after.cc)).toEqual(strip(before.cc));
    expect(after.docs.map((d) => [d.id, d.supplier_directory_id])).toEqual(
      before.docs.map((d) => [d.id, d.supplier_directory_id]),
    );
  });

  it('склейка без файлов: near_inn и ручная пара — запись, повтор пуст, откат', async () => {
    // Цель с корректным ИНН и дубль с одной неверной цифрой и опечаткой в
    // имени: правила 22.10 их не связывают — ключи имён разные.
    const target = await supplier({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: INN.race });
    const near = await supplier({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: '7716203629' });
    // «ООО «МОЖАЙСК»» → «АО "ИСТКУЛЬТ МОЖАЙСК"»: имя другое, только ручная пара.
    const istkult = await supplier({ name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', inn: '5028021698' });
    const mozhaisk = await supplier({ name: 'ООО «МОЖАЙСК»', inn: '5028024698' });
    const untouched = await supplier({ name: 'ООО "ГРАНИТ"', inn: INN.vist });
    const dNear = await doc(near);
    const dMozhaisk = await doc(mozhaisk);
    const dOther = await doc(untouched);
    const before = await snapshotTables();

    const input: DirectoriesInput = {
      mergesOnly: true,
      nearInn: true,
      pairs: [{ sourceId: mozhaisk, targetId: istkult }],
    };
    // Без флагов склейка по текущей таблице этих дублей не видит.
    const plain = await runDirectoriesImport(db, { mergesOnly: true }, { apply: false });
    expect(plain.plan.supplierDeletes).toEqual([]);

    let snapshot: ImportSnapshot | null = null;
    const r = await applyWithConfirm(input, {
      apply: true,
      beforeWrite: async (s) => {
        snapshot = s;
      },
    });
    expect(r.applied).toBe(true);
    expect([...r.plan.supplierDeletes].sort()).toEqual([near, mozhaisk].sort());

    const rows = await sql<{ id: string; aliases: string[] }[]>`
      select id, aliases from suppliers where id in (${target}, ${istkult})`;
    const aliases = Object.fromEntries(rows.map((x) => [x.id, x.aliases]));
    // near_inn: имя дубля в алиасах; ручная пара: алиас не добавляется.
    expect(aliases[target]).toEqual(['ООО СТД ПЕТРОВИЧЬ']);
    expect(aliases[istkult]).toEqual([]);
    const docs = await sql<{ id: string; supplier_directory_id: string }[]>`
      select id, supplier_directory_id from source_documents order by id`;
    expect(Object.fromEntries(docs.map((d) => [d.id, d.supplier_directory_id]))).toEqual({
      [dNear]: target,
      [dMozhaisk]: istkult,
      [dOther]: untouched,
    });

    // Повтор с теми же флагами — ноль операций, пара помечена «уже склеен».
    const again = await runDirectoriesImport(db, input, { apply: false });
    expect(again.plan.opCount).toBe(0);
    expect(again.plan.merges!.pairIssues.map((i) => i.problem)).toEqual([
      'источника нет — уже склеен или удалён',
    ]);

    await revertDirectoriesImport(db, snapshot!, { apply: true });
    const strip = (rows: postgres.Row[]) => rows.map(({ updated_at: _u, ...rest }) => rest);
    const after = await snapshotTables();
    expect(strip(after.suppliers)).toEqual(strip(before.suppliers));
    expect(after.docs.map((d) => [d.id, d.supplier_directory_id])).toEqual(
      before.docs.map((d) => [d.id, d.supplier_directory_id]),
    );
  });
});
