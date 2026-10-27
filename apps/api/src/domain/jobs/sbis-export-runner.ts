/**
 * Выгрузка реестра УПД из СБИС (Saby) — один проход по учётке.
 *
 * Тот же реестр edo_export_documents и тот же журнал edo_export_runs, что у
 * Диадока; общая часть «XML → разбор → строка реестра → файл» — storeExportXml.
 * Своё здесь только чтение ленты СБИС и скачивание.
 *
 * Лента (справка «СБИС.СписокИзменений», проверено пробой 22.10):
 *   - курсор — последнее событие страницы: ИдентификаторСобытия + ДатаВремяС
 *     (строкой СБИС, как пришла), документ и редакция; `НашаОрганизация` — на
 *     каждой странице;
 *   - пустая страница — ещё не конец: справка велит выждать и повторить тот же
 *     запрос. Поэтому пустая страница ставит в курсор `confirm` (тот же
 *     ДатаВремяПо) и подтверждающую задачу через 2 минуты; ЛЮБОЙ следующий
 *     проход начинает с этого подтверждения (задача могла не дойти). Пусто и
 *     при подтверждении — лента проверена до confirm.until: это и есть
 *     feed_completed_at (не now(): иначе свежесть реестра завышена);
 *   - ошибка курсора («Не найдено событие…») — один повтор по времени
 *     последнего обработанного события, второй раз — ошибка прохода.
 * Документы: в работу — только входящие УПД события «Получение»
 * (`isIncomingReceipt`); ключ строки — документ и вложение; 403 на ссылке —
 * свежая ссылка через ПрочитатьДокумент той же редакции, снова 403 — проход
 * стоп (курсор на прежней странице).
 *
 * Всё под лизом учётки; курсор пишется одним оператором с продлением лиза.
 */
import { and, asc, eq, lte, sql as drSql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { EdoSbisCredentials } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import {
  edoAccounts,
  edoExportCursors,
  edoExportDocuments,
  edoExportRuns,
  type EdoExportRunOutcome,
} from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import {
  recordExportFailure,
  storeExportXml,
  type EntityOutcome,
  type ExportPut,
  type ExportRef,
} from '../edo/export-upd.js';
import { EdoLeaseLost } from '../edo/inventory.js';
import { acquireEdoLease, releaseEdoLease, renewEdoLease } from '../edo/poll-lease.js';
import { isSbisAccount, readSbisCredentials, SBIS_PROVIDER } from '../edo/sbis/sbis-account.js';
import { loginByKey, type SbisSession } from '../edo/sbis/sbis.auth.js';
import { createSbisClient, type SbisClient, type SbisCursor, type SbisOrgRef } from '../edo/sbis/sbis.client.js';
import { collectSbisAttachments, isIncomingReceipt, type SbisAttachmentRecord } from '../edo/sbis/sbis.entities.js';
import { SbisAborted, SbisAccessDenied, SbisGone, SbisPayloadTooLarge, SbisRpcError } from '../edo/sbis/sbis.http.js';
import { parseOrgRef } from '../edo/sbis/sbis.org-ref.js';
import { formatSbisDateTime, isYes, parseSbisDateTime, sbisDateToIso, type SbisAttachment, type SbisDocument } from '../edo/sbis/sbis.types.js';
import { extractSingleXml, ZipRejected } from '../edo/zip-single-xml.js';
import { parseSince, RUN_RETENTION_DAYS, saveCursorKey } from './edo-export-runner.js';
import { errorChain } from '../../lib/error-chain.js';

/** Идентичность запроса ленты СБИС в edo_export_cursors (вместе с организацией в box_id). */
export const SBIS_FEED_QUERY = 'sbis:changes:v1';

/** Через сколько подтверждать пустую страницу (справка: 1–5 минут). */
export const SBIS_CONFIRM_DELAY_MS = 2 * 60 * 1000;

const RETRY_BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Состояние ленты СБИС — JSON в edo_export_cursors.index_key. */
export type SbisCursorState = {
  v: 1;
  /** Последнее обработанное событие; null — событий ещё не было. */
  eventId: string | null;
  /** Его ДатаВремя — строкой СБИС, как пришла (доли секунды важны). */
  eventTime: string | null;
  documentId: string | null;
  revisionId: string | null;
  /** Пустая страница ждёт подтверждения тем же запросом: ДатаВремяПо строкой СБИС. */
  confirm: { until: string } | null;
  /** До какого момента лента проверена подтверждённой пустой страницей (ISO). */
  verifiedUntil: string | null;
};

const EMPTY_STATE: SbisCursorState = {
  v: 1,
  eventId: null,
  eventTime: null,
  documentId: null,
  revisionId: null,
  confirm: null,
  verifiedUntil: null,
};

/** Испорченный курсор — не повод молча начать сначала: проход останавливается. */
export class SbisCursorCorrupted extends Error {
  constructor() {
    super('курсор выгрузки СБИС не читается: нужен явный сброс (удалите строку edo_export_cursors этой учётки)');
    this.name = 'SbisCursorCorrupted';
  }
}

/** Лента не сдвинулась: та же последняя страница или страница без событий. */
export class SbisFeedStuck extends Error {
  constructor(reason: string) {
    super(`лента СБИС: ${reason} — проход остановлен`);
    this.name = 'SbisFeedStuck';
  }
}

/** И свежая ссылка отвечает 403: дело не в ссылке, а в доступе. Проход стоп. */
export class SbisFileAccessDenied extends Error {
  constructor(documentId: string) {
    super(`СБИС отказывает в доступе к файлу документа ${documentId} и по свежей ссылке`);
    this.name = 'SbisFileAccessDenied';
  }
}

export function parseCursorState(raw: string | null): SbisCursorState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const value = JSON.parse(raw) as Partial<SbisCursorState>;
    if (value?.v !== 1) throw new Error('version');
    return { ...EMPTY_STATE, ...value, v: 1 };
  } catch {
    throw new SbisCursorCorrupted();
  }
}

export function serializeCursorState(state: SbisCursorState): string {
  return JSON.stringify(state);
}

/** Курсор для запроса: событие (или только время после восстановления); нет — от даты. */
function cursorOf(state: SbisCursorState): SbisCursor | null {
  if (!state.eventTime) return null;
  return { eventId: state.eventId, eventTime: state.eventTime, documentId: state.documentId, revisionId: state.revisionId };
}

/** Ошибка курсора по справке: «Не найдено событие с идентификатором» / «ещё не обработанное событие». */
export function isSbisCursorError(err: unknown): boolean {
  if (!(err instanceof SbisRpcError)) return false;
  const text = err.detail.toLowerCase();
  return text.includes('не найдено событие') || (text.includes('событи') && text.includes('не обработан'));
}

export type SbisExportMode = { trigger: 'auto' | 'script'; maxEvents: number; maxDownloads: number };

export type SbisExportDeps = {
  db: Db;
  log: FastifyBaseLogger;
  owner: string;
  put: ExportPut;
  signal?: AbortSignal;
  /** Подтверждающий проход через SBIS_CONFIRM_DELAY_MS (очередь mail-worker'а). */
  scheduleConfirm?: (accountId: string) => Promise<void>;
  /** Для тестов: вход и клиент без сети. */
  login?: (creds: EdoSbisCredentials) => Promise<SbisSession>;
  createClient?: (session: SbisSession, signal?: AbortSignal) => SbisClient;
  now?: () => Date;
};

export type SbisExportSummary = {
  pages: number;
  eventsSeen: number;
  /** Входящие УПД события «Получение» на прочитанных страницах. */
  candidates: number;
  stored: number;
  failed: number;
  /** Уже в реестре (сохранены или ждут повтора) — не качались. */
  alreadyKnown: number;
  /** Та же УПД пришла в новом событии «Получение» — не перекачивалась. */
  revisionsIgnored: number;
  downloads: number;
  refreshedLinks: number;
  cursorRecoveries: number;
  truncated: boolean;
  truncateReason: 'limit' | null;
  /** Пустая страница подтверждена: лента проверена до verifiedUntil. */
  feedConfirmed: boolean;
  /** Пустая страница ждёт подтверждения. */
  confirmPending: boolean;
};

export type SbisRetrySummary = { picked: number; stored: number; failed: number; closed: number };

export type SbisExportResult =
  | { skipped: 'lease_taken' | 'no_box' | 'not_found' | 'inactive' | 'provider' }
  | {
      runId: string;
      outcome: Exclude<EdoExportRunOutcome, 'running'>;
      summary: SbisExportSummary;
      retry: SbisRetrySummary | null;
      error: string | null;
      cause?: unknown;
      cursorMismatch?: boolean;
    };

function emptySummary(): SbisExportSummary {
  return {
    pages: 0,
    eventsSeen: 0,
    candidates: 0,
    stored: 0,
    failed: 0,
    alreadyKnown: 0,
    revisionsIgnored: 0,
    downloads: 0,
    refreshedLinks: 0,
    cursorRecoveries: 0,
    truncated: false,
    truncateReason: null,
    feedConfirmed: false,
    confirmPending: false,
  };
}

/** С причинами: у сбоя запроса drizzle текст Postgres — в `cause` (error-chain.ts). */
function errorText(err: unknown): string {
  return errorChain(err);
}

/** Где взять файл вложения: ссылка или причина, почему её нет. */
type FreshLink = { link: string } | { reason: string; final: boolean };

/** Результат скачивания: байты XML или причина сбоя документа. */
type Fetched = { bytes: Buffer } | { reason: string; retryable: boolean };

/** Найти вложение в ответе ПрочитатьДокумент / ленте документа. */
function findAttachment(docs: SbisDocument[], attachmentId: string): SbisAttachment | null {
  for (const d of docs) {
    for (const a of [...d.Вложение, ...d.Событие.flatMap((e) => e.Вложение)]) {
      if (a.Идентификатор?.trim() === attachmentId) return a;
    }
  }
  return null;
}

/** Учётки СБИС, по которым идёт выгрузка: активные, с выбранной организацией. */
export async function listSbisExportAccounts(db: Db): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: edoAccounts.id, name: edoAccounts.name })
    .from(edoAccounts)
    .where(
      and(eq(edoAccounts.isActive, true), drSql`${edoAccounts.boxId} is not null`, eq(edoAccounts.provider, SBIS_PROVIDER)),
    )
    .orderBy(edoAccounts.name, edoAccounts.id);
}

export type SbisAutoReport = {
  onError: (accountId: string, result: Extract<SbisExportResult, { runId: string }>) => void;
  onCrash: (accountId: string, err: unknown) => void;
};

/** Автопроход по всем учёткам СБИС по очереди; сбой одной не срывает остальные. */
export async function runSbisExportForAllAccounts(
  deps: SbisExportDeps,
  limits: { maxEvents: number; maxDownloads: number },
  report: SbisAutoReport,
): Promise<void> {
  for (const account of await listSbisExportAccounts(deps.db)) {
    try {
      const result = await runSbisExportPass(deps, account.id, { trigger: 'auto', ...limits });
      if ('skipped' in result) {
        deps.log.info({ accountId: account.id, skipped: result.skipped }, 'выгрузка СБИС пропущена');
        continue;
      }
      deps.log.info(
        { accountId: account.id, runId: result.runId, outcome: result.outcome, summary: result.summary, retry: result.retry },
        'выгрузка СБИС завершена',
      );
      if (result.outcome === 'error') report.onError(account.id, result);
    } catch (err) {
      deps.log.error({ accountId: account.id, err }, 'выгрузка СБИС упала');
      report.onCrash(account.id, err);
    }
  }
}

/** Один проход выгрузки СБИС по учётке. Исход — в журнале и в ответе; исключения не выходят. */
export async function runSbisExportPass(
  deps: SbisExportDeps,
  accountId: string,
  mode: SbisExportMode,
): Promise<SbisExportResult> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  const [account] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
  if (!account) return { skipped: 'not_found' };
  if (!isSbisAccount(account)) return { skipped: 'provider' };
  if (!account.isActive) return { skipped: 'inactive' };
  const org: SbisOrgRef | null = parseOrgRef(account.boxId);
  if (!org || !account.boxId) return { skipped: 'no_box' };
  const boxId = account.boxId;
  const env = loadEnv();
  const ttlSeconds = env.EDO_POLL_LEASE_SEC;

  const lease = await acquireEdoLease(db, { accountId, owner: deps.owner, ttlSeconds, requirePollEnabled: false });
  if (!lease) return { skipped: 'lease_taken' };

  try {
    await db
      .update(edoExportRuns)
      .set({ outcome: 'error', error: 'прервано: процесс остановлен до конца прохода', finishedAt: new Date() })
      .where(and(eq(edoExportRuns.edoAccountId, accountId), eq(edoExportRuns.outcome, 'running')));

    const configured = parseSince(env.EDO_SBIS_SINCE);
    await db
      .insert(edoExportCursors)
      .values({ edoAccountId: accountId, boxId, feedQuery: SBIS_FEED_QUERY, since: configured })
      .onConflictDoNothing();
    const [cursorRow] = await db.select().from(edoExportCursors).where(eq(edoExportCursors.edoAccountId, accountId));
    if (cursorRow!.boxId !== boxId || cursorRow!.feedQuery !== SBIS_FEED_QUERY) {
      const error =
        `курсор выгрузки от другой организации или запроса (${cursorRow!.boxId}, ${cursorRow!.feedQuery}; ` +
        `сейчас ${boxId}, ${SBIS_FEED_QUERY}). Нужен явный сброс: удалите строку edo_export_cursors этой учётки`;
      const [run] = await db
        .insert(edoExportRuns)
        .values({
          edoAccountId: accountId,
          scope: 'all',
          trigger: mode.trigger,
          outcome: 'error',
          indexKeyBefore: cursorRow!.indexKey,
          indexKeyAfter: cursorRow!.indexKey,
          finishedAt: new Date(),
          error,
        })
        .returning({ id: edoExportRuns.id });
      return { runId: run!.id, outcome: 'error', summary: emptySummary(), retry: null, error, cursorMismatch: true };
    }

    const [run] = await db
      .insert(edoExportRuns)
      .values({ edoAccountId: accountId, scope: 'all', trigger: mode.trigger, indexKeyBefore: cursorRow!.indexKey })
      .returning({ id: edoExportRuns.id });
    const runId = run!.id;

    const summary = emptySummary();
    let retry: SbisRetrySummary | null = null;
    let outcome: Exclude<EdoExportRunOutcome, 'running'>;
    let error: string | null = null;
    let cause: unknown;
    let feedCompletedAt: Date | null = null;
    let savedKey = cursorRow!.indexKey;

    try {
      let state = parseCursorState(cursorRow!.indexKey);
      const creds = readSbisCredentials(account);
      const session = await (deps.login ?? loginByKey)(creds);
      const client = deps.createClient
        ? deps.createClient(session, deps.signal)
        : createSbisClient({ session, transport: { signal: deps.signal } });

      const ensureLease = async () => {
        if (!(await renewEdoLease(db, lease, ttlSeconds))) throw new EdoLeaseLost();
      };
      const saveState = async (next: SbisCursorState) => {
        const key = serializeCursorState(next);
        await saveCursorKey(db, lease, ttlSeconds, key);
        savedKey = key;
        state = next;
      };
      const sinceFor = (s: SbisCursorState) => (s.verifiedUntil ? new Date(s.verifiedUntil) : cursorRow!.since);

      /** Страница ленты; ошибка курсора — один повтор по времени последнего события. */
      const readPage = async (until: Date) => {
        await ensureLease();
        const cursor = cursorOf(state);
        try {
          return await client.listChanges({ org, since: sinceFor(state), until, cursor });
        } catch (err) {
          if (!isSbisCursorError(err) || !cursor?.eventId) throw err;
          summary.cursorRecoveries += 1;
          log.warn({ accountId, eventId: cursor.eventId }, 'sbis export: ошибка курсора — повтор по времени события');
          await ensureLease();
          return client.listChanges({
            org,
            since: sinceFor(state),
            until,
            cursor: { eventId: null, eventTime: cursor.eventTime, documentId: null, revisionId: null },
          });
        }
      };

      /** Свежая ссылка на файл вложения: ПрочитатьДокумент, при частичном ответе — лента документа. */
      const freshLink = async (
        documentId: string,
        revisionId: string | null,
        attachmentId: string,
        around: Date | null,
      ): Promise<FreshLink> => {
        await ensureLease();
        const doc = await client.readDocument({ documentId, revisionId });
        if (isYes(doc.Удален)) return { reason: 'документ удалён в СБИС', final: true };
        let att = findAttachment([doc], attachmentId);
        if (!att && isYes(doc.ЧастичныеДанные)) {
          await ensureLease();
          const since = new Date((around ?? now()).getTime() - DAY_MS);
          const docs = await client.listDocumentChanges({ org, documentId, since, until: now() });
          att = findAttachment(docs, attachmentId);
          if (!att) return { reason: 'СБИС вернул частичный ответ, вложение не найдено — повтор позже', final: false };
        }
        if (!att) return { reason: 'вложения нет в ответе СБИС', final: true };
        const link = att.Файл?.Ссылка?.trim();
        if (!link) return { reason: 'у вложения нет ссылки на файл', final: true };
        return { link };
      };

      /** Скачать XML вложения: 403 — свежая ссылка, снова 403 — стоп прохода; zip — распаковка. */
      const fetchXml = async (
        link: string,
        documentId: string,
        revisionId: string | null,
        attachmentId: string,
        around: Date | null,
      ): Promise<Fetched> => {
        let dl: { bytes: Buffer; zip: boolean };
        try {
          await ensureLease();
          summary.downloads += 1;
          dl = await client.downloadFile(link, env.EDO_XML_MAX_BYTES);
        } catch (err) {
          if (err instanceof SbisGone) return { reason: 'файл исчез из СБИС', retryable: false };
          if (err instanceof SbisPayloadTooLarge) {
            return { reason: `файл больше ${Math.round(env.EDO_XML_MAX_BYTES / 1024 / 1024)} МБ`, retryable: false };
          }
          if (!(err instanceof SbisAccessDenied)) throw err;
          // Ссылка могла устареть (живёт месяц): берём свежую той же редакции.
          const fresh = await freshLink(documentId, revisionId, attachmentId, around);
          if (!('link' in fresh)) return { reason: fresh.reason, retryable: !fresh.final };
          summary.refreshedLinks += 1;
          try {
            await ensureLease();
            summary.downloads += 1;
            dl = await client.downloadFile(fresh.link, env.EDO_XML_MAX_BYTES);
          } catch (err2) {
            if (err2 instanceof SbisAccessDenied) throw new SbisFileAccessDenied(documentId);
            if (err2 instanceof SbisGone) return { reason: 'файл исчез из СБИС', retryable: false };
            if (err2 instanceof SbisPayloadTooLarge) {
              return { reason: `файл больше ${Math.round(env.EDO_XML_MAX_BYTES / 1024 / 1024)} МБ`, retryable: false };
            }
            throw err2;
          }
        }
        if (!dl.zip) return { bytes: dl.bytes };
        try {
          return { bytes: extractSingleXml(dl.bytes, env.EDO_XML_MAX_BYTES).bytes };
        } catch (err) {
          if (err instanceof ZipRejected) return { reason: err.message, retryable: false };
          throw err;
        }
      };

      const storeDeps = { db, log, put: deps.put };
      const tally = (o: EntityOutcome) => {
        if (o === 'stored') summary.stored += 1;
        else if (o === 'failed') summary.failed += 1;
      };
      const handled = new Set<string>();

      const handleAttachment = async (rec: SbisAttachmentRecord) => {
        summary.candidates += 1;
        const key = `${rec.documentId}\u0000${rec.attachmentId}`;
        if (handled.has(key)) return;
        handled.add(key);
        const [existing] = await db
          .select({ status: edoExportDocuments.status, receivedAt: edoExportDocuments.receivedAt })
          .from(edoExportDocuments)
          .where(
            and(
              eq(edoExportDocuments.edoAccountId, accountId),
              eq(edoExportDocuments.messageId, rec.documentId),
              eq(edoExportDocuments.entityId, rec.attachmentId!),
            ),
          )
          .limit(1);
        if (existing) {
          // Сохранённая — не трогаем; сбойная — её повторяет проход повторов.
          summary.alreadyKnown += 1;
          const at = parseSbisDateTime(rec.eventTime);
          if (existing.status === 'stored' && at && existing.receivedAt && at.getTime() !== existing.receivedAt.getTime()) {
            summary.revisionsIgnored += 1;
            log.warn({ accountId, documentId: rec.documentId }, 'sbis export: УПД получена повторно — оставлена первая');
          }
          return;
        }
        const ref: ExportRef = {
          accountId,
          messageId: rec.documentId,
          entityId: rec.attachmentId!,
          documentType: rec.attachmentType ?? 'unknown',
          documentFunction: null,
          documentNumber: rec.attachmentNumber ?? rec.documentNumber,
          documentDate: sbisDateToIso(rec.attachmentDate ?? rec.documentDate),
          fileName: rec.fileName,
          counteragentBoxId: null,
          receivedAt: parseSbisDateTime(rec.eventTime),
          providerRevisionId: rec.documentRevisionId,
        };
        const got = await fetchXml(rec.link!, rec.documentId, rec.documentRevisionId, rec.attachmentId!, ref.receivedAt);
        if (!('bytes' in got)) {
          tally(await recordExportFailure(storeDeps, ref, got.reason, got.retryable));
          return;
        }
        tally(await storeExportXml(storeDeps, ref, got.bytes, null));
      };

      /** Документы страницы → строки реестра; затем курсор = последнее событие страницы. */
      const processPage = async (documents: SbisDocument[], receivedAt: Date) => {
        let last: SbisCursor | null = null;
        for (const doc of documents) {
          for (const ev of doc.Событие) {
            summary.eventsSeen += 1;
            if (ev.Идентификатор && ev.ДатаВремя) {
              last = {
                eventId: ev.Идентификатор,
                eventTime: ev.ДатаВремя,
                documentId: doc.Идентификатор ?? null,
                revisionId: doc.Редакция[0]?.Идентификатор ?? null,
              };
            }
          }
          for (const rec of collectSbisAttachments(doc, receivedAt)) {
            if (rec.isUpd && isIncomingReceipt(rec) && rec.attachmentId && rec.documentId) await handleAttachment(rec);
          }
        }
        if (!last) throw new SbisFeedStuck('на странице нет событий с идентификатором');
        if (state.eventId && last.eventId === state.eventId) throw new SbisFeedStuck('страница не сдвинула курсор');
        await saveState({
          ...state,
          eventId: last.eventId,
          eventTime: last.eventTime,
          documentId: last.documentId,
          revisionId: last.revisionId,
          confirm: null,
        });
      };

      // 0. Незакрытое подтверждение — первым: отложенная задача могла не дойти.
      if (state.confirm) {
        const until = parseSbisDateTime(state.confirm.until);
        if (!until) throw new SbisCursorCorrupted();
        const page = await readPage(until);
        summary.pages += 1;
        if (page.documents.length === 0) {
          await saveState({ ...state, confirm: null, verifiedUntil: until.toISOString() });
          feedCompletedAt = until;
          summary.feedConfirmed = true;
        } else {
          state = { ...state, confirm: null };
          await processPage(page.documents, page.receivedAt);
        }
      }

      // 1. Новый интервал: до момента старта прохода.
      const passUntil = now();
      for (;;) {
        if (summary.eventsSeen >= mode.maxEvents || summary.downloads >= mode.maxDownloads) {
          summary.truncated = true;
          summary.truncateReason = 'limit';
          break;
        }
        const page = await readPage(passUntil);
        summary.pages += 1;
        if (page.documents.length === 0) {
          await saveState({ ...state, confirm: { until: formatSbisDateTime(passUntil) } });
          summary.confirmPending = true;
          await deps.scheduleConfirm?.(accountId).catch((err) =>
            log.warn({ accountId, err: errorText(err) }, 'sbis export: подтверждение не поставлено — подтвердит следующий проход'),
          );
          break;
        }
        await processPage(page.documents, page.receivedAt);
      }

      retry = await retrySbisFailed({ db, log, accountId, freshLink, fetchXml, storeDeps });
      outcome = summary.truncated ? 'truncated' : 'completed';
    } catch (err) {
      outcome = err instanceof EdoLeaseLost || err instanceof SbisAborted ? 'stopped' : 'error';
      error = errorText(err);
      cause = err;
    }

    await db
      .update(edoExportRuns)
      .set({
        outcome,
        truncateReason: summary.truncateReason,
        finishedAt: new Date(),
        feedCompletedAt,
        indexKeyAfter: savedKey,
        eventsSeen: summary.eventsSeen,
        stored: summary.stored + (retry?.stored ?? 0),
        failed: summary.failed + (retry?.failed ?? 0),
        retried: retry?.picked ?? 0,
        census: 0,
        error,
      })
      .where(eq(edoExportRuns.id, runId));
    await db
      .delete(edoExportRuns)
      .where(
        and(
          eq(edoExportRuns.edoAccountId, accountId),
          drSql`${edoExportRuns.startedAt} < now() - make_interval(days => ${RUN_RETENTION_DAYS})`,
        ),
      );
    return { runId, outcome, summary, retry, error, cause };
  } finally {
    await releaseEdoLease(db, lease).catch(() => {});
  }
}

/**
 * Повтор сбойных документов СБИС по расписанию (1/6/24/72 ч): свежая ссылка
 * через ПрочитатьДокумент той же редакции — лента их второй раз не принесёт.
 */
async function retrySbisFailed(ctx: {
  db: Db;
  log: FastifyBaseLogger;
  accountId: string;
  freshLink: (documentId: string, revisionId: string | null, attachmentId: string, around: Date | null) => Promise<FreshLink>;
  fetchXml: (
    link: string,
    documentId: string,
    revisionId: string | null,
    attachmentId: string,
    around: Date | null,
  ) => Promise<Fetched>;
  storeDeps: { db: Db; log: FastifyBaseLogger; put: ExportPut };
}): Promise<SbisRetrySummary> {
  const out: SbisRetrySummary = { picked: 0, stored: 0, failed: 0, closed: 0 };
  const due = await ctx.db
    .select()
    .from(edoExportDocuments)
    .where(
      and(
        eq(edoExportDocuments.edoAccountId, ctx.accountId),
        eq(edoExportDocuments.status, 'failed'),
        lte(edoExportDocuments.nextRetryAt, drSql`now()`),
      ),
    )
    .orderBy(asc(edoExportDocuments.nextRetryAt))
    .limit(RETRY_BATCH);
  for (const row of due) {
    out.picked += 1;
    const ref: ExportRef = {
      accountId: ctx.accountId,
      messageId: row.messageId,
      entityId: row.entityId,
      documentType: row.documentType,
      documentFunction: row.documentFunction,
      documentNumber: row.documentNumber,
      documentDate: row.documentDate ? row.documentDate.toISOString().slice(0, 10) : null,
      fileName: null,
      counteragentBoxId: null,
      receivedAt: row.receivedAt,
      providerRevisionId: row.providerRevisionId,
    };
    const fresh = await ctx.freshLink(row.messageId, row.providerRevisionId, row.entityId, row.receivedAt);
    if (!('link' in fresh)) {
      await recordExportFailure(ctx.storeDeps, ref, fresh.reason, !fresh.final);
      if (fresh.final) out.closed += 1;
      else out.failed += 1;
      continue;
    }
    const got = await ctx.fetchXml(fresh.link, row.messageId, row.providerRevisionId, row.entityId, row.receivedAt);
    if (!('bytes' in got)) {
      await recordExportFailure(ctx.storeDeps, ref, got.reason, got.retryable);
      if (got.retryable) out.failed += 1;
      else out.closed += 1;
      continue;
    }
    const outcome = await storeExportXml(ctx.storeDeps, ref, got.bytes, null);
    if (outcome === 'stored') out.stored += 1;
    else out.failed += 1;
  }
  return out;
}
