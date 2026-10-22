/**
 * Проба СБИС: только чтение. Отвечает на вопросы, от которых зависит
 * подключение СБИС к реестру УПД (этап Р):
 *   1. Пускает ли СБИС с нашими ключами и каким способом.
 *   2. Какие организации видны и полон ли их список.
 *   3. Что лежит в ленте за интервал: документы, события, вложения, направления,
 *      УПД; дочитана ли лента до конца интервала; как ведёт себя курсор.
 *   4. Какие входящие УПД уже есть в реестре Диадока (предварительно) и каких там
 *      нет — второе только когда обе стороны просмотрены полностью.
 *   5. Читает ли наш парсер УПД из СБИС и как отдаются файлы (в том числе 403).
 *
 * Правила, принятые после двух внешних ревью плана:
 *   - пустая страница ленты — не конец: справка велит выждать 1–5 минут и
 *     повторить с теми же параметрами; конец — пусто и после повтора;
 *   - срок жизни ссылки на файл не выводится из даты события: на 403 берётся
 *     свежая ссылка через `ПрочитатьДокумент`, не различили — `unknown`;
 *   - «не найдено в Диадоке» — только при полном списке организаций, ленте,
 *     просмотренной до конца интервала, и полном реестре Диадока за интервал;
 *     совпадение по ИНН, номеру и дате — признак, а не доказательство.
 *
 * Модуль не ходит в сеть и в БД сам: клиент, вход и загрузка реестра приходят
 * параметрами. Запуск — scripts/sbis-probe.ts.
 */
import { classifyUtdContent } from '../document-kind.js';
import { assessUpdParse, parseUpdXml } from '../upd.parser.js';
import { decodeXmlBuffer } from '../upd-xml-decode.js';
import { documentNumberCore, normalizeDocumentNumber } from '../../operations/edo-match.js';
import type { SbisSession } from './sbis.auth.js';
import {
  orgLabel,
  orgRefOf,
  type SbisClient,
  type SbisCursor,
  type SbisOrgList,
  type SbisOrgRef,
} from './sbis.client.js';
import { assessDiadocCoverage, type DiadocCoverageRow } from './diadoc-coverage.js';
import {
  SbisAttachmentSet,
  attachmentKey,
  collectSbisAttachments,
  revisionOf,
  type SbisUniqueAttachment,
} from './sbis.entities.js';
import { SbisAccessDenied, SbisRequestNotAllowed, SbisRpcError } from './sbis.http.js';
import { isYes, parseSbisDateTime, sbisDateToIso } from './sbis.types.js';

export type DiadocRegistryRow = {
  status: string;
  document_number: string | null;
  /** ГГГГ-ММ-ДД. */
  document_date: string | null;
  supplier_inn: string | null;
  seller_inns: string[] | null;
};

export type SbisProbeDeps = {
  login: () => Promise<SbisSession>;
  createClient: (session: SbisSession, onRequest: (what: string) => void) => SbisClient;
  /** Сверка с реестром Диадока; нет — шаг пропускается. */
  diadoc?: {
    loadCoverage: () => Promise<DiadocCoverageRow[]>;
    loadRegistry: (inns: string[]) => Promise<DiadocRegistryRow[]>;
  };
  /** Сохраняет скачанный образец, возвращает путь. */
  saveSample?: (name: string, bytes: Buffer) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export type SbisProbeOptions = {
  since: Date;
  /** Фиксируется при запуске: без этого «просмотрен до …» не имеет смысла. */
  until: Date;
  /** ИНН или ИНН/КПП; нет — все организации с подключённым ЭДО. */
  org?: string | null;
  maxDocs: number;
  sample: number;
  emptyWaitMs: number;
  pageCap?: number;
  maxFileBytes?: number;
};

export type SbisProbeReport = {
  startedAt: string;
  finishedAt?: string;
  interval: { since: string; until: string };
  requests: Record<string, number>;
  steps: Record<string, unknown>;
  errors: { step: string; error: string }[];
  summary: string[];
};

export type FeedOutcome =
  | { state: 'interval_scanned' }
  | {
      state: 'truncated';
      reason: 'max_docs' | 'page_cap' | 'stuck_cursor' | 'cursor_error' | 'error';
      error?: string;
    };

type OrgScan = {
  org: SbisOrgRef;
  label: string;
  feed: FeedOutcome;
  attachments: SbisAttachmentSet;
  stats: Record<string, unknown>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Справка: ссылки «действительны один месяц». Только для подбора образцов разного возраста. */
const LINK_MONTH_MS = 30 * DAY_MS;
const DEFAULT_PAGE_CAP = 1000;
const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024;

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function tally<T>(items: readonly T[], by: (item: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = by(item) ?? '(пусто)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Ошибка курсора по справке: «Не найдено событие с идентификатором» / «ещё не обработанное событие». */
export function isCursorError(err: unknown): boolean {
  if (!(err instanceof SbisRpcError)) return false;
  const text = err.detail.toLowerCase();
  return text.includes('не найдено событие') || (text.includes('событи') && text.includes('не обработан'));
}

/** ИНН или ИНН/КПП из --org в организацию для фильтра. */
export function parseOrgArg(value: string): SbisOrgRef {
  const [inn = '', kpp] = value.split('/').map((p) => p.trim());
  if (!/^\d{10}$|^\d{12}$/.test(inn)) throw new Error(`--org: ожидается ИНН или ИНН/КПП, получено «${value}»`);
  return inn.length === 12
    ? { kind: 'person', inn, kpp: null, branch: null, name: null }
    : { kind: 'legal', inn, kpp: kpp || null, branch: null, name: null };
}

function sameOrg(a: SbisOrgRef, b: SbisOrgRef): boolean {
  return a.inn === b.inn && (!b.kpp || a.kpp === b.kpp);
}

/** Обход ленты одной организации за интервал. */
export async function scanFeed(
  client: SbisClient,
  org: SbisOrgRef,
  opts: Pick<SbisProbeOptions, 'since' | 'until' | 'maxDocs' | 'emptyWaitMs' | 'pageCap'>,
  sleep: (ms: number) => Promise<void>,
): Promise<OrgScan> {
  const label = orgLabel(org);
  const attachments = new SbisAttachmentSet();
  const layout: Record<string, number> = {};
  const documentIds = new Set<string>();
  const seenEvents = new Set<string>();
  const pageCap = opts.pageCap ?? DEFAULT_PAGE_CAP;
  let pages = 0;
  let events = 0;
  let eventRepeats = 0;
  let stepsBack = 0;
  let recoveries = 0;
  let emptyWaits = 0;
  let pagesWithoutMore = 0;
  let firstEvent: Date | null = null;
  let maxEvent: Date | null = null;
  let cursor: SbisCursor | null = null;
  let emptyRetried = false;
  let recoveredOnThisStep = false;
  let feed: FeedOutcome | null = null;

  while (!feed) {
    if (pages >= pageCap) {
      feed = { state: 'truncated', reason: 'page_cap' };
      break;
    }
    let page;
    try {
      page = await client.listChanges({ org, since: opts.since, until: opts.until, cursor });
    } catch (err) {
      // Справка: при ошибке курсора — указать дату и время последнего
      // обработанного события и повторить. Один раз на шаг: повтор той же
      // ошибки значит, что восстановление не помогает.
      if (isCursorError(err) && cursor?.eventId && !recoveredOnThisStep) {
        recoveries += 1;
        recoveredOnThisStep = true;
        cursor = { eventId: null, eventTime: cursor.eventTime, documentId: null, revisionId: null };
        continue;
      }
      feed = {
        state: 'truncated',
        reason: isCursorError(err) ? 'cursor_error' : 'error',
        error: errorText(err),
      };
      break;
    }
    pages += 1;
    if (page.hasMore === false) pagesWithoutMore += 1;

    if (page.documents.length === 0) {
      // Пустая страница — ещё не конец: справка велит выждать и повторить с теми
      // же параметрами. Конец интервала — пусто и после повтора.
      if (emptyRetried) {
        feed = { state: 'interval_scanned' };
        break;
      }
      emptyRetried = true;
      emptyWaits += 1;
      await sleep(opts.emptyWaitMs);
      continue;
    }
    emptyRetried = false;
    recoveredOnThisStep = false;

    let next: SbisCursor | null = null;
    for (const doc of page.documents) {
      if (doc.Идентификатор) documentIds.add(doc.Идентификатор);
      for (const event of doc.Событие) {
        events += 1;
        if (event.Идентификатор) {
          if (seenEvents.has(event.Идентификатор)) eventRepeats += 1;
          else seenEvents.add(event.Идентификатор);
        }
        const at = parseSbisDateTime(event.ДатаВремя);
        if (at) {
          if (maxEvent && at.getTime() < maxEvent.getTime()) stepsBack += 1;
          if (!maxEvent || at.getTime() > maxEvent.getTime()) maxEvent = at;
          if (!firstEvent || at.getTime() < firstEvent.getTime()) firstEvent = at;
        }
        if (event.Идентификатор && event.ДатаВремя) {
          next = {
            eventId: event.Идентификатор,
            eventTime: event.ДатаВремя,
            documentId: doc.Идентификатор ?? null,
            revisionId: doc.Редакция[0]?.Идентификатор ?? null,
          };
        }
      }
      const records = collectSbisAttachments(doc, page.receivedAt);
      for (const r of records) {
        const k = [r.documentDirection, r.attachmentDirection, r.eventName, r.attachmentType, r.formatVersion]
          .map((v) => v ?? '-')
          .join(' | ');
        layout[k] = (layout[k] ?? 0) + 1;
      }
      attachments.add(records);
    }

    // Курсор — последнее событие страницы. Нет события с идентификатором или
    // курсор не сдвинулся — дальше пришло бы то же самое.
    if (!next || (cursor?.eventId && next.eventId === cursor.eventId)) {
      feed = { state: 'truncated', reason: 'stuck_cursor' };
      break;
    }
    cursor = next;
    if (documentIds.size >= opts.maxDocs) {
      feed = { state: 'truncated', reason: 'max_docs' };
      break;
    }
  }

  const upd = attachments.revisions().filter((r) => r.isUpd);
  const updDates = upd
    .map((r) => sbisDateToIso(r.attachmentDate ?? r.documentDate))
    .filter((d): d is string => !!d)
    .sort();
  const sellers = new Map<string, { inn: string; name: string | null; count: number }>();
  for (const r of upd) {
    const inn = r.counterparty.inn ?? '(без ИНН)';
    const entry = sellers.get(inn) ?? { inn, name: r.counterparty.name, count: 0 };
    entry.count += 1;
    sellers.set(inn, entry);
  }

  return {
    org,
    label,
    feed: feed!,
    attachments,
    stats: {
      org: { ...org },
      feed,
      pages,
      emptyWaits,
      pagesWithoutMore,
      documents: documentIds.size,
      events,
      eventRepeats,
      stepsBackInTime: stepsBack,
      cursorRecoveries: recoveries,
      eventTimeRange: {
        first: firstEvent?.toISOString() ?? null,
        last: maxEvent?.toISOString() ?? null,
      },
      layout: Object.fromEntries(Object.entries(layout).sort((a, b) => b[1] - a[1])),
      layoutKey: 'Направление документа | Направление вложения | Событие | Тип вложения | ВерсияФормата',
      attachmentRepeats: attachments.repeats,
      attachmentsWithoutId: attachments.withoutId,
      upd: {
        byAttachment: attachments.attachmentCount((r) => r.isUpd),
        byRevision: upd.length,
        incomingReceipt: attachments.attachmentCount((r) => r.isUpd && r.incomingReceipt),
        byType: tally(upd, (r) => r.attachmentType),
        byFormatVersion: tally(upd, (r) => r.formatVersion),
        byDirection: tally(upd, (r) => `${r.documentDirection ?? '-'} / ${r.attachmentDirection ?? '-'}`),
        byEvent: tally(upd, (r) => r.eventNames.join(', ') || null),
        documentDateRange: { first: updDates[0] ?? null, last: updDates[updDates.length - 1] ?? null },
        topSellers: [...sellers.values()].sort((a, b) => b.count - a.count).slice(0, 20),
      },
    },
  };
}

type MatchKey = { inn: string; number: string; date: string };

export function matchKeyOf(r: SbisUniqueAttachment): MatchKey | null {
  const inn = r.counterparty.inn?.replace(/\D/g, '') ?? '';
  const number = r.attachmentNumber ?? r.documentNumber ?? '';
  const date = sbisDateToIso(r.attachmentDate ?? r.documentDate);
  if (!inn || !number.trim() || !date) return null;
  return { inn, number, date };
}

/** Предварительная пара в реестре Диадока: тот же ИНН продавца, та же дата, номер точно или по цифрам. */
export function matchInRegistry(
  key: MatchKey,
  rowsByInn: ReadonlyMap<string, DiadocRegistryRow[]>,
): 'exact' | 'digits' | null {
  const rows = (rowsByInn.get(key.inn) ?? []).filter((row) => row.document_date === key.date);
  const exact = normalizeDocumentNumber(key.number);
  if (exact && rows.some((row) => normalizeDocumentNumber(row.document_number) === exact)) return 'exact';
  const core = documentNumberCore(key.number);
  if (core && rows.some((row) => documentNumberCore(row.document_number) === core)) return 'digits';
  return null;
}

export function indexRegistryByInn(rows: readonly DiadocRegistryRow[]): Map<string, DiadocRegistryRow[]> {
  const out = new Map<string, DiadocRegistryRow[]>();
  for (const row of rows) {
    if (row.status === 'failed') continue;
    const inns = new Set([row.supplier_inn, ...(row.seller_inns ?? [])].filter((v): v is string => !!v));
    for (const inn of inns) out.set(inn, [...(out.get(inn) ?? []), row]);
  }
  return out;
}

/** Одна запись на вложение (последняя редакция): сверяется документ, а не его редакции. */
function latestPerAttachment(items: readonly SbisUniqueAttachment[]): SbisUniqueAttachment[] {
  const out = new Map<string, SbisUniqueAttachment>();
  for (const r of items) out.set(attachmentKey(r), r);
  return [...out.values()];
}

function brief(r: SbisUniqueAttachment) {
  return {
    key: attachmentKey(r),
    sellerInn: r.counterparty.inn,
    seller: r.counterparty.name,
    number: r.attachmentNumber ?? r.documentNumber,
    date: r.attachmentDate ?? r.documentDate,
    type: r.attachmentType,
    formatVersion: r.formatVersion,
    events: r.eventNames,
  };
}

/**
 * Образцы: разные продавцы и типы, по возможности и старые, и свежие события.
 * Возраст события ссылку не характеризует — смесь нужна, чтобы увидеть, как
 * отдаются файлы в обоих случаях, а не чтобы отсечь старые.
 */
export function pickSamples(pool: readonly SbisUniqueAttachment[], n: number, now: Date): SbisUniqueAttachment[] {
  const isOld = (r: SbisUniqueAttachment) => {
    const at = parseSbisDateTime(r.eventTime);
    return !!at && now.getTime() - at.getTime() > LINK_MONTH_MS;
  };
  const queues = [pool.filter(isOld), pool.filter((r) => !isOld(r))];
  const picked: SbisUniqueAttachment[] = [];
  const usedCombos = new Set<string>();
  const usedKeys = new Set<string>();
  const combo = (r: SbisUniqueAttachment) => `${r.counterparty.inn ?? ''}|${r.attachmentType ?? ''}`;

  for (const distinct of [true, false]) {
    let turn = 0;
    let stalled = 0;
    while (picked.length < n && stalled < queues.length) {
      const queue = queues[turn % queues.length]!;
      turn += 1;
      const idx = queue.findIndex((r) => !usedKeys.has(attachmentKey(r)) && (!distinct || !usedCombos.has(combo(r))));
      if (idx < 0) {
        stalled += 1;
        continue;
      }
      stalled = 0;
      const [r] = queue.splice(idx, 1);
      picked.push(r!);
      usedKeys.add(attachmentKey(r!));
      usedCombos.add(combo(r!));
    }
  }
  return picked;
}

export type DownloadOutcome =
  | { outcome: 'ok'; bytes: Buffer; zip: boolean }
  | { outcome: 'refreshed_ok'; bytes: Buffer; zip: boolean; variant: 'by_revision' | 'by_document' }
  | { outcome: 'unknown'; reason: string; variant?: 'by_revision' | 'by_document' }
  | { outcome: 'host_not_allowed'; host: string }
  | { outcome: 'error'; error: string };

function hostOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return '(не адрес)';
  }
}

/**
 * Скачивание образца. На 403 — свежая ссылка через `ПрочитатьДокумент` той же
 * редакции документа (если её идентификатор был в ленте, иначе по документу —
 * это последняя редакция). Сработала — `refreshed_ok`; не различили причину —
 * `unknown`. По дате события причину не выводим: срок ссылки считается не от неё.
 */
export async function downloadSample(
  client: SbisClient,
  r: SbisUniqueAttachment,
  maxBytes: number,
): Promise<DownloadOutcome> {
  const fetchLink = async (link: string) => client.downloadFile(link, maxBytes);
  try {
    const { bytes, zip } = await fetchLink(r.link!);
    return { outcome: 'ok', bytes, zip };
  } catch (err) {
    if (err instanceof SbisRequestNotAllowed) return { outcome: 'host_not_allowed', host: hostOf(r.link!) };
    if (!(err instanceof SbisAccessDenied)) return { outcome: 'error', error: errorText(err) };
  }

  const variant = r.documentRevisionId ? 'by_revision' : 'by_document';
  let doc;
  try {
    doc = await client.readDocument({ documentId: r.documentId, revisionId: r.documentRevisionId });
  } catch (err) {
    return { outcome: 'unknown', variant, reason: `ПрочитатьДокумент: ${errorText(err)}` };
  }
  const att = [...doc.Вложение, ...doc.Событие.flatMap((e) => e.Вложение)].find(
    (a) => a.Идентификатор?.trim() === r.attachmentId,
  );
  if (!att) return { outcome: 'unknown', variant, reason: 'вложения нет в ответе ПрочитатьДокумент' };
  const rev = revisionOf(att);
  if (r.attachmentRevision.number && rev.number && rev.number !== r.attachmentRevision.number) {
    return {
      outcome: 'unknown',
      variant,
      reason: `ПрочитатьДокумент вернул другую редакцию вложения (${rev.number} вместо ${r.attachmentRevision.number})`,
    };
  }
  const link = att.Файл?.Ссылка?.trim();
  if (!link) return { outcome: 'unknown', variant, reason: 'в ответе ПрочитатьДокумент нет ссылки на файл' };
  try {
    const { bytes, zip } = await fetchLink(link);
    return { outcome: 'refreshed_ok', bytes, zip, variant };
  } catch (err) {
    if (err instanceof SbisRequestNotAllowed) return { outcome: 'host_not_allowed', host: hostOf(link) };
    if (err instanceof SbisAccessDenied) {
      return { outcome: 'unknown', variant, reason: 'повторно полученная ссылка тоже отвечает 403' };
    }
    return { outcome: 'unknown', variant, reason: errorText(err) };
  }
}

function parseSampleXml(bytes: Buffer) {
  try {
    const parsed = parseUpdXml(decodeXmlBuffer(bytes));
    const assessment = assessUpdParse(parsed);
    const content = classifyUtdContent(parsed);
    return {
      number: parsed.docNumber || null,
      date: parsed.docDate || null,
      sellerInn: parsed.supplier.inn || null,
      function: parsed.function,
      formatVersion: parsed.formatVersion,
      items: parsed.items.length,
      totalSum: parsed.totalSum,
      assessment,
      category: content.category,
      categoryReason: content.reason,
    };
  } catch (err) {
    return { parseError: errorText(err) };
  }
}

const safeName = (value: string) => value.replace(/[^\w.-]+/g, '_').slice(0, 80);

export async function runSbisProbe(
  deps: SbisProbeDeps,
  opts: SbisProbeOptions,
  report: SbisProbeReport,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    console.info(`— ${name}…`);
    try {
      const result = await fn();
      report.steps[name] = result;
      return result;
    } catch (err) {
      const message = errorText(err);
      report.errors.push({ step: name, error: message });
      console.error(`  шаг «${name}» не прошёл: ${message}`);
      return null;
    }
  }

  // 1. Вход. Сессия держится вне отчёта: в ней токен.
  const auth: { session: SbisSession | null } = { session: null };
  await step('login', async () => {
    const session = await deps.login();
    auth.session = session;
    report.summary.push(`Вход: прошёл (${session.mode === 'key' ? 'по ключу' : 'логином'})`);
    return { mode: session.mode, ok: true };
  });
  if (!auth.session) {
    report.summary.push('Вход: не прошёл — дальше проба не идёт');
    return;
  }
  const client = deps.createClient(auth.session, (what) => {
    report.requests[what] = (report.requests[what] ?? 0) + 1;
  });

  // 2. Организации.
  let orgList: SbisOrgList | null = null;
  const targets: SbisOrgRef[] = [];
  await step('organizations', async () => {
    orgList = await client.listOurOrganizations();
    const listed = orgList.orgs.map((org) => ({ ref: orgRefOf(org), edo: isYes(org.ДокументооборотПодключен) }));
    if (opts.org) {
      const wanted = parseOrgArg(opts.org);
      const found = listed.find((o) => o.ref && sameOrg(o.ref, wanted));
      targets.push(found?.ref ?? wanted);
    } else {
      for (const o of listed) if (o.ref && o.edo) targets.push(o.ref);
    }
    report.summary.push(
      `Организации: ${orgList.orgs.length}, с ЭДО ${listed.filter((o) => o.edo).length}; ` +
        `список ${orgList.complete ? 'полный' : `НЕПОЛНЫЙ (${orgList.stopReason})`}`,
    );
    return {
      complete: orgList.complete,
      pages: orgList.pages,
      stopReason: orgList.stopReason,
      organizations: listed.map((o) => ({ ...o.ref, edo: o.edo })),
      withoutInn: listed.filter((o) => !o.ref).length,
      probed: targets.map(orgLabel),
    };
  });
  // Явно заданная организация смотрится и без списка: он мог не прочитаться.
  if (opts.org && targets.length === 0) targets.push(parseOrgArg(opts.org));

  // 3. Лента по каждой организации.
  const scans: OrgScan[] = [];
  for (const org of targets) {
    await step(`feed ${orgLabel(org)}`, async () => {
      const scan = await scanFeed(client, org, opts, sleep);
      scans.push(scan);
      const upd = scan.stats.upd as { byAttachment: number; incomingReceipt: number };
      report.summary.push(
        `Лента ${scan.label}: ${scan.feed.state === 'interval_scanned' ? `просмотрен интервал до ${opts.until.toISOString()}` : `ОБОРВАНА (${scan.feed.reason})`}; ` +
          `документов ${scan.stats.documents}, УПД ${upd.byAttachment} (входящих «Получение» ${upd.incomingReceipt})`,
      );
      return scan.stats;
    });
  }

  // 4. Сверка с реестром Диадока.
  if (!deps.diadoc) {
    report.steps.reconcile = { skipped: 'не задано подключение к БД портала' };
  } else if (!scans.length) {
    report.steps.reconcile = { skipped: 'нет ни одной прочитанной ленты' };
  } else {
    const diadoc = deps.diadoc;
    await step('reconcile', async () => {
      const allUpd = scans.flatMap((s) => latestPerAttachment(s.attachments.revisions().filter((r) => r.isUpd)));
      const considered = scans.map((s) => ({
        scan: s,
        items: latestPerAttachment(s.attachments.revisions().filter((r) => r.isUpd && r.incomingReceipt)),
      }));
      const consideredAll = considered.flatMap((c) => c.items);
      const keyed = consideredAll.map((r) => ({ r, key: matchKeyOf(r) }));
      const inns = [...new Set(keyed.map((k) => k.key?.inn).filter((v): v is string => !!v))];
      const rowsByInn = indexRegistryByInn(inns.length ? await diadoc.loadRegistry(inns) : []);
      const verdict = new Map<SbisUniqueAttachment, 'exact' | 'digits' | null>();
      for (const { r, key } of keyed) if (key) verdict.set(r, matchInRegistry(key, rowsByInn));

      const coverage = assessDiadocCoverage(await diadoc.loadCoverage(), {
        since: opts.since,
        until: opts.until,
      });
      const blockReasons: string[] = [];
      const list = orgList as SbisOrgList | null;
      if (!list?.complete) blockReasons.push('список организаций СБИС неполный');
      blockReasons.push(...coverage.reasons);
      const scanned = considered.filter((c) => c.scan.feed.state === 'interval_scanned');
      const excludedOrgs = considered
        .filter((c) => c.scan.feed.state !== 'interval_scanned')
        .map((c) => ({ org: c.scan.label, feed: c.scan.feed }));
      if (scanned.length === 0) blockReasons.push('ни одна лента СБИС не просмотрена до конца интервала');

      const found = keyed.filter((k) => k.key && verdict.get(k.r));
      const notFound = scanned.flatMap((c) => c.items).filter((r) => matchKeyOf(r) && !verdict.get(r));
      const receiptRuleUnconfirmed = consideredAll.length === 0 && allUpd.length > 0;

      report.summary.push(
        `Сверка: входящих УПД «Получение» ${consideredAll.length}; найдено в реестре Диадока (предварительно) ${found.length}; ` +
          (blockReasons.length
            ? `вывод «не найдено» невозможен: ${blockReasons.join('; ')}`
            : `не найдено в проверенном реестре Диадока по предварительным признакам ${notFound.length}`),
      );
      if (receiptRuleUnconfirmed) {
        report.summary.push('Внимание: УПД есть, но ни одной входящей в событии «Получение» — правило на данных не подтверждено');
      }

      return {
        considered: consideredAll.length,
        updTotal: allUpd.length,
        receiptRuleUnconfirmed,
        withoutMatchKey: keyed.filter((k) => !k.key).length,
        foundInDiadoc: {
          title: 'найдено в реестре Диадока (предварительно)',
          note: 'совпадение ИНН продавца, даты и номера — признак, а не доказательство того же УПД',
          exact: found.filter((k) => verdict.get(k.r) === 'exact').length,
          digitsOnly: found.filter((k) => verdict.get(k.r) === 'digits').length,
        },
        diadocCoverage: coverage,
        notFoundInDiadoc: blockReasons.length
          ? { blocked: true, reasons: blockReasons }
          : {
              blocked: false,
              title: 'не найдено в проверенном реестре Диадока по предварительным признакам',
              count: notFound.length,
              excludedOrgs,
              bySeller: Object.entries(tally(notFound, (r) => `${r.counterparty.inn ?? '-'} ${r.counterparty.name ?? ''}`.trim()))
                .slice(0, 20)
                .map(([seller, count]) => ({ seller, count })),
              samples: notFound.slice(0, 30).map(brief),
            },
      };
    });
  }

  // 5. Образцы.
  if (opts.sample > 0 && scans.length) {
    await step('samples', async () => {
      const pool = latestPerAttachment(scans.flatMap((s) => s.attachments.revisions().filter((r) => r.isUpd)));
      const at = now();
      const picked = pickSamples(pool, opts.sample, at);
      const out = [];
      for (const [i, r] of picked.entries()) {
        const eventAt = parseSbisDateTime(r.eventTime);
        const entry: Record<string, unknown> = {
          ...brief(r),
          eventTime: r.eventTime,
          eventAgeDays: eventAt ? Math.floor((at.getTime() - eventAt.getTime()) / DAY_MS) : null,
          linkReceivedAt: r.linkReceivedAt,
          linkHost: hostOf(r.link!),
        };
        const dl = await downloadSample(client, r, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
        if (dl.outcome === 'ok' || dl.outcome === 'refreshed_ok') {
          entry.download = { outcome: dl.outcome, ...(dl.outcome === 'refreshed_ok' ? { variant: dl.variant } : {}) };
          entry.bytes = dl.bytes.length;
          entry.kind = dl.zip ? 'zip' : 'xml';
          if (deps.saveSample) {
            const name = `${String(i + 1).padStart(2, '0')}-${safeName(r.attachmentId ?? 'att')}.${dl.zip ? 'zip' : 'xml'}`;
            entry.savedAs = await deps.saveSample(name, dl.bytes);
          }
          // Zip (многостраничное вложение или ответ ПрочитатьДокумент) в пробе не
          // распаковываем: zip-библиотеки в api нет, это вопрос этапа Р.
          entry.parse = dl.zip ? { skipped: 'zip не разбирается в пробе' } : parseSampleXml(dl.bytes);
        } else {
          entry.download = dl;
        }
        out.push(entry);
      }
      const outcomes = tally(out, (e) => (e.download as { outcome: string }).outcome);
      report.summary.push(
        `Образцы: ${out.length} из ${pool.length} УПД; скачивание: ${Object.entries(outcomes)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ') || '—'}`,
      );
      return { pool: pool.length, outcomes, samples: out };
    });
  }
}
