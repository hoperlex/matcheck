/**
 * Новая модель машины: группа по факту загрузки + «на планшет едет только
 * обработанное». Всё под рубильником GROUPS_ROLLOUT.
 *
 * Почему набор нужен именно интеграционный. Оба правила — SQL-предикаты,
 * подставляемые в выборки, и проверять их можно только у самой БД: коррелятами,
 * левыми join'ами и NULL-семантикой они отличаются от того, что «читается» в
 * коде. Юнит-тест здесь проверял бы форму строки, а не поведение.
 *
 * Опорный случай набора — «карточка со скриншота»: машина из двух обработанных
 * УПД и двух их дубликатов. Инспектор должен получить ровно два документа, а не
 * шесть, и вся четвёрка обязана делить один groupId, иначе приложение нарисует
 * несколько карточек на один рейс.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourceDocuments } from '../../src/db/schema.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('машина по факту загрузки (реальный PostgreSQL)', () => {
  let sql_: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  /** Предикаты и правило группы с рубильником ВКЛЮЧЁН. */
  let onVisible: () => ReturnType<typeof sql>;
  let onGroupId: () => ReturnType<typeof sql>;
  /** То же с рубильником ВЫКЛЮЧЕН — прежнее поведение. */
  let offVisible: () => ReturnType<typeof sql>;
  let offGroupId: () => ReturnType<typeof sql>;
  /** Рубильник включён, но с отсечкой «только будущие загрузки». */
  let sinceVisible: () => ReturnType<typeof sql>;
  let sinceGroupId: () => ReturnType<typeof sql>;

  const siteId = randomUUID();
  const contractorId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  async function bundle(
    id: string,
    opts: {
      parent?: string | null;
      assembly?: string;
      active?: number;
      publicChannel?: boolean;
      createdDaysAgo?: number;
    } = {},
  ) {
    const createdAt = new Date(
      Date.now() - (opts.createdDaysAgo ?? 0) * 86_400_000,
    ).toISOString();
    await sql_`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version,
         published_generation, active_upload_generation, parent_bundle_id, created_at)
      VALUES (${id}, ${hash('gr')}, 'inbound', ${siteId}, 'parsed', 'mixed',
              ${opts.assembly ?? 'legacy'}, null, ${opts.active ?? 0},
              ${opts.parent ?? null}, ${createdAt}::timestamptz)`;
    // Отметка «пришло с публичной страницы» ставится только на КОРЕНЬ: у
    // дочерних пакетов (накладные, сборка) события нет, и правило обязано
    // находить его через coalesce(parent_bundle_id, id).
    if (opts.publicChannel !== false && !opts.parent) {
      await sql_`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
                 VALUES (${id}, 'public', ${randomUUID().slice(0, 20)})`;
    }
  }

  async function doc(opts: {
    id: string;
    bundleId: string;
    status?: string;
    code?: string | null;
    kind?: string;
    number?: string;
    queuedMinutesAgo?: number | null;
    queuedAtNull?: boolean;
    createdMinutesAgo?: number;
  }) {
    // ISO-строкой, а не объектом Date: в сыром шаблоне postgres.js тип
    // параметра не выведен, и Date до сервера не доезжает.
    const queuedAt =
      opts.queuedAtNull || opts.queuedMinutesAgo == null
        ? null
        : new Date(Date.now() - opts.queuedMinutesAgo * 60_000).toISOString();
    const createdAt = new Date(
      Date.now() - (opts.createdMinutesAgo ?? 0) * 60_000,
    ).toISOString();
    await sql_`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id,
         parse_error_code, queued_at, created_at)
      VALUES (${opts.id}, ${opts.kind ?? 'upd'}, false, 'inbound', 'manual_pdf',
              ${opts.status ?? 'parsed'}, ${siteId}, now(),
              ${opts.number ?? 'ГР-1'}, now(), 100, ${opts.bundleId}, now(),
              ${contractorId}, ${opts.code ?? null},
              ${queuedAt}::timestamptz, ${createdAt}::timestamptz)`;
  }

  /** Строка реестра: файл принят, документа по нему может не быть. */
  async function registryRow(
    bundleId: string,
    opts: { key?: string | null; status?: string; generation?: number; resolved?: boolean } = {},
  ) {
    await sql_`INSERT INTO bundle_import_items
        (bundle_id, source_filename, status, input_s3_key, upload_generation,
         processing_mode, resolved_at)
      VALUES (${bundleId}, 'файл.jpg', ${opts.status ?? 'accepted'},
              ${opts.key === undefined ? `gr/${bundleId}/${randomUUID()}.jpg` : opts.key},
              ${opts.generation ?? 0}, 'auto',
              ${opts.resolved ? new Date().toISOString() : null}::timestamptz)`;
  }

  async function value<T>(pred: () => ReturnType<typeof sql>, id: string): Promise<T> {
    const [row] = await db
      .select({ v: sql<T>`${pred()}` })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, id));
    return row.v;
  }

  beforeAll(async () => {
    sql_ = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql_);
    await sql_`INSERT INTO sites (id, code, name)
               VALUES (${siteId}, ${`GRP${Date.now() % 10000}`}, 'Машины')`;
    await sql_`INSERT INTO counterparties (id, inn, name, is_contractor)
               VALUES (${contractorId}, ${`79${Date.now() % 100000000}`}, 'Подрядчик машин', true)`;

    // Два независимых экземпляра модулей: loadEnv кеширует разбор окружения при
    // первом обращении, поэтому «прогрев» каждого варианта обязателен — иначе
    // оба прочитают то значение, которое стояло в момент первого вызова.
    process.env.GROUPS_ROLLOUT = '1';
    vi.resetModules();
    const onVis = await import('../../src/domain/sourceDocuments/mobile-visibility.js');
    const onGrp = await import('../../src/domain/sourceDocuments/document-group.js');
    onVisible = onVis.mobileVisibleSourceDocumentSql;
    onGroupId = onGrp.documentGroupIdSql;
    onVisible();

    // Рубильник включён, но с отсечкой: правило действует только на пачки,
    // принятые начиная со вчерашнего дня.
    process.env.GROUPS_ROLLOUT = '1';
    process.env.GROUPS_ROLLOUT_SINCE = new Date(Date.now() - 86_400_000).toISOString();
    vi.resetModules();
    const sinceVis = await import('../../src/domain/sourceDocuments/mobile-visibility.js');
    const sinceGrp = await import('../../src/domain/sourceDocuments/document-group.js');
    sinceVisible = sinceVis.mobileVisibleWithinRolloutSql;
    sinceGroupId = sinceGrp.documentGroupIdSql;
    sinceVisible();
    delete process.env.GROUPS_ROLLOUT_SINCE;

    process.env.GROUPS_ROLLOUT = '0';
    vi.resetModules();
    const offVis = await import('../../src/domain/sourceDocuments/mobile-visibility.js');
    const offGrp = await import('../../src/domain/sourceDocuments/document-group.js');
    offVisible = offVis.mobileVisibleSourceDocumentSql;
    offGroupId = offGrp.documentGroupIdSql;
    offVisible();
  });

  afterAll(async () => {
    if (!sql_) return;
    delete process.env.GROUPS_ROLLOUT;
    await sql_`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM bundle_import_items WHERE bundle_id IN
                 (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql_`DELETE FROM ingest_events WHERE bundle_id IN
                 (SELECT id FROM source_bundles WHERE site_id = ${siteId})`;
    await sql_`DELETE FROM source_bundles WHERE site_id = ${siteId} AND parent_bundle_id IS NOT NULL`;
    await sql_`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql_`DELETE FROM sites WHERE id = ${siteId}`;
    await sql_.end();
  });

  it('карточка со скриншота: два готовых УПД и два их дубликата → инспектору два документа', async () => {
    const root = randomUUID();
    const okA = randomUUID();
    const okB = randomUUID();
    const dupA = randomUUID();
    const dupB = randomUUID();
    await bundle(root);
    await doc({ id: okA, bundleId: root, number: '201/21126947' });
    await doc({ id: okB, bundleId: root, number: '201/21126947-1' });
    await doc({
      id: dupA, bundleId: root, number: '201/21126947',
      status: 'needs_resolution', code: 'duplicate_upd',
    });
    await doc({
      id: dupB, bundleId: root, number: '201/21126947-1',
      status: 'needs_resolution', code: 'duplicate_upd',
    });

    // Видны только обработанные — дубликаты не едут и машину не держат.
    expect(await value<boolean>(onVisible, okA)).toBe(true);
    expect(await value<boolean>(onVisible, okB)).toBe(true);
    expect(await value<boolean>(onVisible, dupA)).toBe(false);
    expect(await value<boolean>(onVisible, dupB)).toBe(false);

    // И это одна машина: без общего groupId приложение нарисует две карточки.
    expect(await value<string>(onGroupId, okA)).toBe(root);
    expect(await value<string>(onGroupId, okB)).toBe(root);

    // Прежнее правило: дубликат держал ВСЮ машину — ровно та поломка, из-за
    // которой готовые документы не доезжали до инспектора.
    expect(await value<string | null>(offGroupId, okA)).toBeNull();
  });

  it('несобранный пакет с портала — машина; почта и ЭДО — нет', async () => {
    const pub = randomUUID();
    const mail = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    await bundle(pub);
    await bundle(mail, { publicChannel: false });
    await doc({ id: a, bundleId: pub });
    await doc({ id: b, bundleId: mail });

    // assembly_version остался 'legacy' — постраничная сборка откатилась или не
    // запускалась, но рейс от этого одним быть не перестал.
    expect(await value<string>(onGroupId, a)).toBe(pub);
    expect(await value<string | null>(onGroupId, b)).toBeNull();
    // Прежнее правило не считало машиной ни тот, ни другой.
    expect(await value<string | null>(offGroupId, a)).toBeNull();
  });

  it('накладная из дочернего пакета входит в ту же машину', async () => {
    const root = randomUUID();
    const child = randomUUID();
    const upd = randomUUID();
    const waybill = randomUUID();
    await bundle(root);
    await bundle(child, { parent: root });
    await doc({ id: upd, bundleId: root });
    await doc({ id: waybill, bundleId: child, kind: 'transport_waybill', number: '1694172' });

    expect(await value<string>(onGroupId, upd)).toBe(root);
    expect(await value<string>(onGroupId, waybill)).toBe(root);
    expect(await value<boolean>(onVisible, waybill)).toBe(true);
  });

  it('заглушка «не распознано» машину не держит', async () => {
    const root = randomUUID();
    const ok = randomUUID();
    const stub = randomUUID();
    await bundle(root);
    await doc({ id: ok, bundleId: root });
    await doc({
      id: stub, bundleId: root, kind: 'transport_waybill',
      status: 'needs_resolution', code: 'no_waybill_found',
    });

    expect(await value<boolean>(onVisible, ok)).toBe(true);
    expect(await value<boolean>(onVisible, stub)).toBe(false);
  });

  it('неполно распознанный документ машину не держит: она едет из готового', async () => {
    const root = randomUUID();
    const ok = randomUUID();
    const partial = randomUUID();
    await bundle(root);
    await doc({ id: ok, bundleId: root });
    await doc({ id: partial, bundleId: root, status: 'needs_resolution', code: 'partial_parse' });

    expect(await value<boolean>(onVisible, ok)).toBe(true);
    expect(await value<boolean>(onVisible, partial)).toBe(false);
    // Прежнее правило до такого пакета вообще не доходило: несобранный пакет
    // машиной не считался, поэтому и проверять было нечего — каждый документ
    // отвечал сам за себя и ехал отдельной карточкой.
    expect(await value<string | null>(offGroupId, ok)).toBeNull();
    expect(await value<boolean>(offVisible, ok)).toBe(true);
  });

  it('документ в разборе держит машину, но не дольше получаса', async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    const okFresh = randomUUID();
    const okStale = randomUUID();
    const rootFresh = randomUUID();
    const rootStale = randomUUID();
    await bundle(rootFresh);
    await bundle(rootStale);
    await doc({ id: okFresh, bundleId: rootFresh });
    await doc({ id: fresh, bundleId: rootFresh, status: 'queued', queuedMinutesAgo: 2 });
    await doc({ id: okStale, bundleId: rootStale });
    await doc({ id: stale, bundleId: rootStale, status: 'queued', queuedMinutesAgo: 120 });

    expect(await value<boolean>(onVisible, okFresh)).toBe(false);
    // Зависшее задание не должно гасить машину навсегда: на бою документ
    // простоял в очереди 21 час.
    expect(await value<boolean>(onVisible, okStale)).toBe(true);
  });

  it('возраст разбора считается по created_at, когда queued_at не проставлен', async () => {
    const root = randomUUID();
    const ok = randomUUID();
    const stale = randomUUID();
    await bundle(root);
    await doc({ id: ok, bundleId: root });
    await doc({
      id: stale, bundleId: root, status: 'queued',
      queuedAtNull: true, createdMinutesAgo: 120,
    });

    expect(await value<boolean>(onVisible, ok)).toBe(true);
  });

  it('принятый файл без документа держит машину, а закрытая и безключевая строки — нет', async () => {
    const rootPending = randomUUID();
    const rootResolved = randomUUID();
    const rootNoKey = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await bundle(rootPending);
    await bundle(rootResolved);
    await bundle(rootNoKey);
    await doc({ id: a, bundleId: rootPending });
    await doc({ id: b, bundleId: rootResolved });
    await doc({ id: c, bundleId: rootNoKey });
    await registryRow(rootPending);
    await registryRow(rootResolved, { resolved: true });
    // Файл не долетел до хранилища: ключа нет, заглушку по такой строке никто не
    // заведёт — без исключения машина погасла бы навсегда.
    await registryRow(rootNoKey, { key: null, status: 'failed' });

    expect(await value<boolean>(onVisible, a)).toBe(false);
    expect(await value<boolean>(onVisible, b)).toBe(true);
    expect(await value<boolean>(onVisible, c)).toBe(true);
  });

  it('поколение загрузки в переходе: комплект прошлой отправки не выдаётся как целая машина', async () => {
    const root = randomUUID();
    const old = randomUUID();
    await bundle(root, { active: 1 });
    await doc({ id: old, bundleId: root });
    // Реестр прошлого поколения есть, реестра нового ещё нет — окно между
    // поднятием поколения и удалением старых документов.
    await registryRow(root, { generation: 0 });

    expect(await value<boolean>(onVisible, old)).toBe(false);
  });

  it('метка удаления уносит объект КОРНЯ, а не документа', async () => {
    // Объект документа менеджер может сменить или очистить, а выборка меток
    // фильтрует по объекту события. Возьми мы объект документа — планшет
    // прежнего объекта метку не получит, и документ останется у него навсегда.
    const otherSite = randomUUID();
    await sql_`INSERT INTO sites (id, code, name)
               VALUES (${otherSite}, ${`OTH${Date.now() % 10000}`}, 'Чужой объект')`;
    const root = randomUUID();
    const moved = randomUUID();
    await bundle(root);
    await doc({ id: moved, bundleId: root, status: 'needs_resolution', code: 'duplicate_upd' });
    // документ «переехал» на другой объект уже после приёма пачки
    await sql_`UPDATE source_documents SET site_id = ${otherSite} WHERE id = ${moved}`;

    const { recordVisibilityTransitions } = await import(
      '../../src/domain/sourceDocuments/visibility-events.js'
    );
    await recordVisibilityTransitions(db, {
      documentIds: [moved],
      reason: 'тест переноса объекта',
    });

    const [ev] = await sql_`SELECT site_id, visibility FROM source_document_visibility_events
                             WHERE source_document_id = ${moved}
                             ORDER BY created_at DESC LIMIT 1`;
    expect(ev.visibility).toBe('hidden');
    expect(ev.site_id).toBe(siteId);

    await sql_`DELETE FROM source_document_visibility_events WHERE source_document_id = ${moved}`;
    await sql_`UPDATE source_documents SET site_id = ${siteId} WHERE id = ${moved}`;
    await sql_`DELETE FROM sites WHERE id = ${otherSite}`;
  });

  it('больше тысячи меток за интервал — ни одна не теряется', async () => {
    // Отсечка здесь необратима: список удалений не пагинируется, а курсор после
    // ответа уходит вперёд. Всё, что не влезло, теряется навсегда — документ
    // остаётся на планшете до переустановки. Выкатной прогон разом пишет сотни
    // меток, поэтому предел проверяем явно.
    const since = new Date(Date.now() - 60_000);
    const root = randomUUID();
    await bundle(root);
    const anchor = randomUUID();
    await doc({ id: anchor, bundleId: root, status: 'needs_resolution', code: 'duplicate_upd' });
    // События пишем напрямую: важна выборка, а не тысяча настоящих документов.
    await sql_`INSERT INTO source_document_visibility_events
                 (source_document_id, visibility, site_id, reason)
               SELECT ${anchor}, 'hidden', ${siteId}, 'нагрузочная метка ' || g
                 FROM generate_series(1, 1200) g`;

    const { selectVisibilityTombstones } = await import(
      '../../src/domain/sourceDocuments/visibility-events.js'
    );
    const ids = await selectVisibilityTombstones(db, { since, siteId });
    expect(ids).toContain(anchor);

    const [{ count }] = await sql_`SELECT count(*)::int AS count
                                     FROM source_document_visibility_events
                                    WHERE source_document_id = ${anchor}`;
    expect(count).toBeGreaterThan(1000);
    await sql_`DELETE FROM source_document_visibility_events WHERE source_document_id = ${anchor}`;
  });

  it('отсечка по дате: старая пачка живёт по прежним правилам, новая — по новым', async () => {
    // Пачка, принятая ДО выката, уже разошлась по планшетам: инспектор видел её
    // состав, часть документов мог оформить. Менять её задним числом нельзя —
    // это забрать у него то, с чем он вчера работал.
    const oldRoot = randomUUID();
    const newRoot = randomUUID();
    const oldOk = randomUUID();
    const oldDup = randomUUID();
    const newOk = randomUUID();
    const newDup = randomUUID();
    await bundle(oldRoot, { createdDaysAgo: 5 });
    await bundle(newRoot);
    await doc({ id: oldOk, bundleId: oldRoot, number: 'СТАР-1' });
    await doc({
      id: oldDup, bundleId: oldRoot, number: 'СТАР-1',
      status: 'needs_resolution', code: 'duplicate_upd',
    });
    await doc({ id: newOk, bundleId: newRoot, number: 'НОВ-1' });
    await doc({
      id: newDup, bundleId: newRoot, number: 'НОВ-1',
      status: 'needs_resolution', code: 'duplicate_upd',
    });

    // Старый дубликат по-прежнему уезжает инспектору — ровно как вчера.
    expect(await value<boolean>(sinceVisible, oldDup)).toBe(true);
    expect(await value<boolean>(sinceVisible, oldOk)).toBe(true);
    // Новый — уже нет.
    expect(await value<boolean>(sinceVisible, newDup)).toBe(false);
    expect(await value<boolean>(sinceVisible, newOk)).toBe(true);

    // И машиной становится только новая пачка.
    expect(await value<string | null>(sinceGroupId, oldOk)).toBeNull();
    expect(await value<string>(sinceGroupId, newOk)).toBe(newRoot);
  });
});
