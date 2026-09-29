/**
 * Пробный разбор и осмотр ящика — на настоящем PostgreSQL.
 *
 * Обе операции обещают «только чтение»: ни событий, ни квитанций, ни карточек,
 * ни курсора. Их запускают на боевом ящике при выключенном импорте, поэтому
 * обещание проверяется базой, а не чтением кода. Отдельно — лиз: проверка
 * содержимого идёт дольше, чем лиз живёт без продления, и без лиза работать
 * не должна.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdoDryRunReport } from '@matcheck/contracts';
import type { Db } from '../../src/db/client.js';
import { edoAccounts } from '../../src/db/schema.js';
import { runEdoDryRun, supplierHistoryFromDb } from '../../src/domain/edo/dry-run.js';
import { runEdoInventory } from '../../src/domain/jobs/edo-poll-runner.js';
import type { DiadocClient } from '../../src/domain/edo/diadoc.client.js';
import type { DiadocBoxEvent } from '../../src/domain/edo/diadoc.types.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const OUR_BOX = 'box-наш';

function updXml(kind: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR" ВерсФорм="5.03">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерДок="ЦБ-${kind}" ДатаДок="26.08.2026">
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО «Поставщик»" ИННЮЛ="7712345678" КПП="771201001"/></ИдСв></СвПрод>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Бетон" НаимЕдИзм="м3" КолТов="2" ЦенаТов="1000"
               СтТовБезНДС="2000" НалСт="20%" СтТовУчНал="2400">
        <СумНал><СумНал>400</СумНал></СумНал>
        <ДопСведТов ПрТовРаб="${kind}"/>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="2000" СтТовУчНалВсего="2400"><СумНалВсего><СумНал>400</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;
}

function event(n: number, info: Record<string, unknown>): DiadocBoxEvent {
  return {
    EventId: `ev-${n}`,
    IndexKey: `ik-${String(n).padStart(4, '0')}`,
    Message: {
      MessageId: `msg-${n}`,
      FromBoxId: 'box-контрагента',
      ToBoxId: OUR_BOX,
      Entities: [
        {
          EntityId: `ent-${n}`,
          EntityType: 'Attachment',
          DocumentInfo: {
            TypeNamedId: 'UniversalTransferDocument',
            Function: 'СЧФДОП',
            Version: 'utd970_05_03_01',
            ...info,
          },
        },
        // Подпись к документу: документом не считается.
        { EntityId: `sig-${n}`, EntityType: 'Signature', ParentEntityId: `ent-${n}` },
      ],
    },
  } as DiadocBoxEvent;
}

/** Клиент, отдающий ленту и содержимое; `onDownload` видит каждое скачивание. */
function fakeClient(feed: DiadocBoxEvent[], kindOf: (entityId: string) => number, onDownload?: (n: number) => Promise<void>) {
  let downloads = 0;
  return {
    getNewEvents: vi.fn(async ({ afterIndexKey }: { afterIndexKey?: string | null }) => {
      const start = afterIndexKey ? feed.findIndex((e) => e.IndexKey === afterIndexKey) + 1 : 0;
      return { events: feed.slice(start, start + 100) };
    }),
    getDocumentTypes: vi.fn(async () => []),
    getEntityContent: vi.fn(async (_b: string, _m: string, entityId: string) => {
      downloads += 1;
      await onDownload?.(downloads);
      return Buffer.from(updXml(kindOf(entityId)), 'utf8');
    }),
  } as unknown as DiadocClient;
}

suite('пробный разбор и осмотр: только чтение', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let accountId: string;
  const createdAccounts: string[] = [];
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

  /** Сколько строк в журналах приёма и среди ЭДО-карточек — по всей базе. */
  async function footprint() {
    const [row] = await db.execute<{ events: number; receipts: number; docs: number }>(drSql`
      select (select count(*) from edo_events)::int as events,
             (select count(*) from edo_receipts)::int as receipts,
             (select count(*) from source_documents where origin = 'edo_diadoc')::int as docs
    `);
    return row;
  }

  async function account() {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId));
    return row!;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL as string, { max: 2 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    if (createdAccounts.length > 0) {
      await db.delete(edoAccounts).where(inArray(edoAccounts.id, createdAccounts));
    }
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    accountId = randomUUID();
    createdAccounts.push(accountId);
    await db.insert(edoAccounts).values({
      id: accountId,
      name: `ЭДО ${accountId.slice(0, 8)}`,
      credentialsEncrypted: '{}',
      boxId: OUR_BOX,
    });
  });

  it('пробный разбор отбирает материалы и ничего не пишет', async () => {
    const feed = [
      event(1, {}),
      event(2, {}),
      event(3, { TypeNamedId: 'Invoice', Function: 'default', Version: 'invoice_05_02_01' }),
      event(4, { IsTest: true }),
    ];
    const before = await footprint();

    const result = await runEdoDryRun(db, await account(), log, {
      since: null,
      createClient: () => fakeClient(feed, (id) => (id === 'ent-2' ? 3 : 1)),
    });

    expect('value' in result).toBe(true);
    const report = (result as { value: EdoDryRunReport }).value;
    expect(report.documents.map((d) => [d.entityId, d.content?.category, d.accepted])).toEqual([
      ['ent-1', 'materials', true],
      ['ent-2', 'services', false],
    ]);
    const byMeta = Object.fromEntries(report.selection.byMeta.map((c) => [c.category, c.count]));
    expect(byMeta).toEqual({ utd_candidate: 2, invoice: 1, excluded: 1 });
    // Подсказка из портала посчитана настоящим запросом к базе.
    expect(report.documents[0]!.supplierHistory).toEqual({ deliveries: 0, lastAt: null });

    expect(await footprint()).toEqual(before);
    const after = await account();
    // Лиз отпущен, курсор не тронут.
    expect(after.pollLeaseToken).toBeNull();
    expect(after.lastIndexKey).toBeNull();
  });

  it('история поставщика считается по базе без ошибок', async () => {
    expect(await supplierHistoryFromDb(db, '0000000000')).toEqual({ deliveries: 0, lastAt: null });
  });

  it('осмотр с проверкой содержимого продлевает лиз и пишет только свой отчёт', async () => {
    const feed = Array.from({ length: 25 }, (_, i) => event(i + 1, {}));
    const before = await footprint();
    const leaseUntil: (Date | null)[] = [];

    const outcome = await runEdoInventory(
      {
        db,
        log,
        owner: randomUUID(),
        createClient: () =>
          fakeClient(
            feed,
            (id) => (Number(id.slice(4)) % 5 === 0 ? 3 : 1),
            async (n) => {
              if (n === 1 || n === 12 || n === 22) leaseUntil.push((await account()).pollLeaseUntil);
            },
          ),
      },
      accountId,
      undefined,
      { checkContent: true },
    );

    expect(outcome).toMatchObject({ ok: true });
    const saved = (await account()).lastInventory;
    expect(saved?.contentCheck).toMatchObject({ checked: 25, failed: 0, interrupted: null });
    const byContent = Object.fromEntries(saved!.contentCheck!.byContent.map((c) => [c.category, c.count]));
    expect(byContent).toEqual({ materials: 20, services: 5 });
    // Лиз продлевался по ходу: срок только растёт.
    expect(leaseUntil).toHaveLength(3);
    expect(leaseUntil[1]!.getTime()).toBeGreaterThan(leaseUntil[0]!.getTime());
    expect(leaseUntil[2]!.getTime()).toBeGreaterThan(leaseUntil[1]!.getTime());

    expect(await footprint()).toEqual(before);
    expect((await account()).pollLeaseToken).toBeNull();
  });

  it('лиз перехвачен посреди проверки — осмотр останавливается, отчёт не сохраняется', async () => {
    const feed = Array.from({ length: 25 }, (_, i) => event(i + 1, {}));
    const outcome = await runEdoInventory(
      {
        db,
        log,
        owner: randomUUID(),
        createClient: () =>
          fakeClient(
            feed,
            () => 1,
            async (n) => {
              // Другой процесс забрал учётку: у лиза другой токен.
              if (n === 5) {
                await db
                  .update(edoAccounts)
                  .set({ pollLeaseToken: randomUUID() })
                  .where(eq(edoAccounts.id, accountId));
              }
            },
          ),
      },
      accountId,
      undefined,
      { checkContent: true },
    );

    expect(outcome).toEqual({ skipped: 'lease_lost' });
    const after = await account();
    expect(after.lastInventory).toBeNull();
    // Ошибкой учётки это не считается: связь с Диадоком в порядке.
    expect(after.lastError).toBeNull();
  });
});
