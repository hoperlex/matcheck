/**
 * Проходы выгрузки реестра УПД из ЭДО — с журналом (edo_export_runs).
 *
 * Три охвата:
 *   - `all` — УПД всех продавцов (не только из списка) по постоянному курсору
 *     (edo_export_cursors), плюс перепись и повтор сбоев. Так ходит автопроход
 *     mail-worker'а и ручной `--auto` скрипта. Только он делает реестр
 *     «проверенным». Ящик заново не читается: проход берёт только события после
 *     курсора — в обычные полчаса это одна страница ленты, пустая страница-конец
 *     и одна-две новые УПД (лента ящика — около 570 событий и 47 УПД в сутки);
 *   - `list` — прежняя выгрузка по списку поставщиков с даты `since`;
 *   - `census` — только перепись с даты `since`, без скачиваний и без курсора.
 *
 * Курсор Диадока действителен только для того же запроса ленты, поэтому вместе
 * с ключом хранится вся идентичность запроса: ящик, фильтры, отсечка. Если
 * ящик учётки сменили, проход ленту не читает, пока курсор не сбросят явно
 * (удалением строки edo_export_cursors) — молча продолжить с чужого ключа
 * значило бы пропустить или перечитать неизвестно что.
 *
 * Всё под лизом учётки, как осмотр и опрос: под ним обменивается
 * refresh_token. Ключ курсора пишется одним оператором вместе с продлением
 * лиза: если лиз уже перехвачен, ключ не запишется, и проход остановится.
 */
import { and, desc, eq, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  edoAccounts,
  edoExportCensus,
  edoExportCursors,
  edoExportDocuments,
  edoExportRuns,
  type EdoExportRunOutcome,
} from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { normalizeSupplierName } from '../operations/edo-match.js';
import { createDiadocAuth } from '../edo/diadoc.auth.js';
import { DiadocClient } from '../edo/diadoc.client.js';
import { DiadocAborted } from '../edo/diadoc.http.js';
import {
  EdoExportStopped,
  exportUpdFromBox,
  retryFailedExports,
  type ExportPut,
  type ExportSummary,
  type RetrySummary,
} from '../edo/export-upd.js';
import { EdoLeaseLost } from '../edo/inventory.js';
import {
  acquireEdoLease,
  releaseEdoLease,
  renewEdoLease,
  type LeaseHandle,
} from '../edo/poll-lease.js';
import { DIADOC_PROVIDER, isDiadocAccount } from '../edo/provider.js';
import type { EdoRunnerDeps } from './edo-poll-runner.js';

/** Фильтры ленты выгрузки — те, что передаёт `getNewEvents`. Часть идентичности курсора. */
export const EXPORT_FEED_QUERY = 'Inbound/Ascending';

/** Сколько дней хранить журнал проходов. */
export const RUN_RETENTION_DAYS = 90;

/** Дата YYYY-MM-DD → начало суток по Москве (UTC+3 круглый год). */
export function parseSince(raw: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`ожидается дата ГГГГ-ММ-ДД, получено «${raw}»`);
  const date = new Date(`${raw}T00:00:00+03:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`неверная дата «${raw}»`);
  return date;
}

export type ExportRunMode =
  | {
      scope: 'all';
      trigger: 'auto' | 'script';
      maxEvents: number;
      maxDownloads: number;
    }
  | {
      scope: 'list';
      trigger: 'script';
      since: Date;
      suppliers: ReadonlyMap<string, string>;
      maxEvents?: number;
    }
  | { scope: 'census'; trigger: 'script'; since: Date; maxEvents: number };

export type ExportRunResult =
  | { skipped: 'lease_taken' | 'no_box' | 'not_found' | 'inactive' | 'provider' }
  | {
      runId: string;
      outcome: Exclude<EdoExportRunOutcome, 'running'>;
      summary: ExportSummary | null;
      retry: RetrySummary | null;
      /** Текст для журнала и человека; у `error` — и для Sentry. */
      error: string | null;
      /** Исходная ошибка — для Sentry, в журнал не пишется. */
      cause?: unknown;
      /** Курсор от другого запроса ленты: нужен явный сброс. */
      cursorMismatch?: boolean;
    };

export type ExportRunnerDeps = EdoRunnerDeps & {
  put: ExportPut;
  /** Остановка процесса: проход заканчивается как `stopped`, лиз освобождается. */
  signal?: AbortSignal;
  onPage?: (summary: Readonly<ExportSummary>) => void;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Записать ключ страницы и продлить лиз — одним оператором. Строка учётки
 * блокируется до конца оператора, поэтому перехватить лиз между проверкой и
 * записью нельзя; истёкший лиз тоже не считается своим.
 */
async function saveCursorKey(db: Db, lease: LeaseHandle, ttlSeconds: number, key: string): Promise<void> {
  const rows = await db.execute<{ edo_account_id: string }>(drSql`
    with renewed as (
      update ${edoAccounts}
         set poll_lease_until = now() + make_interval(secs => ${ttlSeconds}), updated_at = now()
       where ${edoAccounts.id} = ${lease.accountId}
         and ${edoAccounts.pollLeaseToken} = ${lease.token}
         and ${edoAccounts.pollLeaseUntil} > clock_timestamp()
      returning id
    )
    update ${edoExportCursors}
       set index_key = ${key}, updated_at = now()
     where edo_account_id in (select id from renewed)
    returning edo_account_id
  `);
  if (rows.length === 0) throw new EdoLeaseLost();
}

/**
 * Один проход выгрузки по учётке: лиз, журнал, обход, для `all` — курсор и
 * повторы. Исключения обхода не выходят наружу: исход записан в журнал и
 * возвращается вызывающему (тот решает про Sentry).
 */
export async function runEdoExportPass(
  deps: ExportRunnerDeps,
  accountId: string,
  mode: ExportRunMode,
): Promise<ExportRunResult> {
  const [account] = await deps.db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
  if (!account) return { skipped: 'not_found' };
  // Этот проход читает ленту Диадока: учётку другого оператора отсекаем до
  // лиза, курсора и журнала — иначе курсор и `running` остались бы от чужого запроса.
  if (!isDiadocAccount(account)) return { skipped: 'provider' };
  if (!account.isActive) return { skipped: 'inactive' };
  if (!account.boxId) return { skipped: 'no_box' };
  const boxId = account.boxId;
  const env = loadEnv();
  const ttlSeconds = env.EDO_POLL_LEASE_SEC;

  const lease = await acquireEdoLease(deps.db, {
    accountId,
    owner: deps.owner,
    ttlSeconds,
    requirePollEnabled: false,
  });
  if (!lease) return { skipped: 'lease_taken' };

  try {
    // Под нашим лизом чужой проход идти не может: незакрытые строки остались
    // от процесса, который убили посреди работы.
    await deps.db
      .update(edoExportRuns)
      .set({ outcome: 'error', error: 'прервано: процесс остановлен до конца прохода', finishedAt: new Date() })
      .where(and(eq(edoExportRuns.edoAccountId, accountId), eq(edoExportRuns.outcome, 'running')));

    let since: Date;
    let afterIndexKey: string | null = null;
    if (mode.scope === 'all') {
      const configured = parseSince(env.EDO_EXPORT_SINCE);
      await deps.db
        .insert(edoExportCursors)
        .values({ edoAccountId: accountId, boxId, feedQuery: EXPORT_FEED_QUERY, since: configured })
        .onConflictDoNothing();
      const [cursor] = await deps.db
        .select()
        .from(edoExportCursors)
        .where(eq(edoExportCursors.edoAccountId, accountId));
      if (cursor!.boxId !== boxId || cursor!.feedQuery !== EXPORT_FEED_QUERY) {
        const error =
          `курсор выгрузки от другого запроса ленты (ящик ${cursor!.boxId}, ${cursor!.feedQuery}; ` +
          `сейчас ящик ${boxId}, ${EXPORT_FEED_QUERY}). Нужен явный сброс: удалите строку ` +
          `edo_export_cursors этой учётки — следующий проход начнёт с EDO_EXPORT_SINCE`;
        const [run] = await deps.db
          .insert(edoExportRuns)
          .values({
            edoAccountId: accountId,
            scope: mode.scope,
            trigger: mode.trigger,
            outcome: 'error',
            indexKeyBefore: cursor!.indexKey,
            indexKeyAfter: cursor!.indexKey,
            finishedAt: new Date(),
            error,
          })
          .returning({ id: edoExportRuns.id });
        return { runId: run!.id, outcome: 'error', summary: null, retry: null, error, cursorMismatch: true };
      }
      if (cursor!.since.getTime() !== configured.getTime()) {
        deps.log.warn(
          { accountId, cursorSince: cursor!.since, configured },
          'edo export: EDO_EXPORT_SINCE расходится с курсором — действует курсор',
        );
      }
      since = cursor!.since;
      afterIndexKey = cursor!.indexKey;
    } else {
      since = mode.since;
    }

    const [run] = await deps.db
      .insert(edoExportRuns)
      .values({
        edoAccountId: accountId,
        scope: mode.scope,
        trigger: mode.trigger,
        indexKeyBefore: afterIndexKey,
      })
      .returning({ id: edoExportRuns.id });
    const runId = run!.id;
    const renewLease = () => renewEdoLease(deps.db, lease, ttlSeconds);

    let summary: ExportSummary | null = null;
    let retry: RetrySummary | null = null;
    let outcome: Exclude<EdoExportRunOutcome, 'running'>;
    let error: string | null = null;
    let cause: unknown;
    try {
      // Клиент создаётся внутри: если сломаны реквизиты (createDiadocAuth
      // бросает), проход закрывается в журнале как `error`, а не оставляет
      // `running` до следующего прохода.
      const client = deps.createClient
        ? deps.createClient(account)
        : new DiadocClient({
            auth: createDiadocAuth({ db: deps.db }, account),
            environment: account.environment,
          });
      const exportDeps = {
        db: deps.db,
        client,
        log: deps.log,
        put: deps.put,
        xmlMaxBytes: env.EDO_XML_MAX_BYTES,
      };
      summary = await exportUpdFromBox(exportDeps, {
        accountId,
        boxId,
        since,
        suppliers: mode.scope === 'list' ? mode.suppliers : null,
        renewLease,
        afterIndexKey,
        onPageDone:
          mode.scope === 'all' ? (key) => saveCursorKey(deps.db, lease, ttlSeconds, key) : undefined,
        maxEvents: mode.maxEvents,
        maxDownloads: mode.scope === 'all' ? mode.maxDownloads : undefined,
        signal: deps.signal,
        census: mode.scope !== 'list',
        downloads: mode.scope !== 'census',
        onPage: deps.onPage,
      });
      if (summary.feedCompleted) {
        await deps.db
          .update(edoExportRuns)
          .set({ feedCompletedAt: new Date() })
          .where(eq(edoExportRuns.id, runId));
      }
      if (mode.scope === 'all') {
        retry = await retryFailedExports(exportDeps, {
          accountId,
          boxId,
          suppliers: null,
          renewLease,
          signal: deps.signal,
        });
      }
      outcome = summary.truncated ? 'truncated' : 'completed';
    } catch (err) {
      const reason = err instanceof EdoExportStopped ? err.reason : err;
      if (err instanceof EdoExportStopped) summary = { ...err.summary };
      outcome = reason instanceof EdoLeaseLost || reason instanceof DiadocAborted ? 'stopped' : 'error';
      error = errorText(reason);
      cause = reason;
    }

    await deps.db
      .update(edoExportRuns)
      .set({
        outcome,
        truncateReason: summary?.truncateReason ?? null,
        finishedAt: new Date(),
        indexKeyAfter: summary?.lastIndexKey ?? afterIndexKey,
        eventsSeen: summary?.eventsSeen ?? 0,
        stored: (summary?.stored ?? 0) + (retry?.stored ?? 0),
        failed: (summary?.failed ?? 0) + (retry?.failed ?? 0),
        retried: retry?.picked ?? 0,
        census: summary?.census ?? 0,
        error,
      })
      .where(eq(edoExportRuns.id, runId));
    // Журнал нужен для «реестр проверен в …» и разбора недавних сбоев. При
    // проходе раз в 30 минут это 48 строк в сутки — старше срока не держим.
    await deps.db
      .delete(edoExportRuns)
      .where(
        and(
          eq(edoExportRuns.edoAccountId, accountId),
          drSql`${edoExportRuns.startedAt} < now() - make_interval(days => ${RUN_RETENTION_DAYS})`,
        ),
      );

    return { runId, outcome, summary, retry, error, cause };
  } finally {
    await releaseEdoLease(deps.db, lease).catch(() => {});
  }
}

/**
 * Три последних полных прохода не дошли до конца и не сдвинули курсор —
 * лента застряла (403 на документ, страница без ключа, битый ответ). Сам по
 * себе каждый такой проход — обычный сбой; три подряд — повод звать человека.
 */
export async function isExportStuck(db: Db, accountId: string): Promise<boolean> {
  const runs = await db
    .select({
      outcome: edoExportRuns.outcome,
      before: edoExportRuns.indexKeyBefore,
      after: edoExportRuns.indexKeyAfter,
    })
    .from(edoExportRuns)
    .where(and(eq(edoExportRuns.edoAccountId, accountId), eq(edoExportRuns.scope, 'all')))
    .orderBy(desc(edoExportRuns.startedAt))
    .limit(3);
  return (
    runs.length === 3 &&
    runs.every((run) => run.outcome !== 'completed' && run.outcome !== 'running' && run.before === run.after)
  );
}

/** Учётки Диадока, по которым идёт выгрузка: активные и с выбранным ящиком. */
export async function listExportAccounts(db: Db): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: edoAccounts.id, name: edoAccounts.name })
    .from(edoAccounts)
    .where(
      and(
        eq(edoAccounts.isActive, true),
        drSql`${edoAccounts.boxId} is not null`,
        eq(edoAccounts.provider, DIADOC_PROVIDER),
      ),
    )
    // Постоянный порядок: проход по учёткам не зависит от плана запроса.
    .orderBy(edoAccounts.name, edoAccounts.id);
}

export type ExportAutoReport = {
  /** Проход закончился `error` — для Sentry. */
  onError: (accountId: string, result: Extract<ExportRunResult, { runId: string }>) => void;
  /** Три прохода подряд не сдвинули курсор. */
  onStuck: (accountId: string) => void;
  /** Проход бросил исключение мимо журнала (сбой БД и т.п.). */
  onCrash: (accountId: string, err: unknown) => void;
};

/**
 * Автопроход выгрузки по всем учёткам Диадока — по очереди, одна за другой.
 * Сбой одной учётки не срывает остальные: прежде исключение на первой учётке
 * выходило из цикла, и до следующих в этом интервале дело не доходило.
 */
export async function runExportForAllAccounts(
  deps: ExportRunnerDeps,
  limits: { maxEvents: number; maxDownloads: number },
  report: ExportAutoReport,
): Promise<void> {
  for (const account of await listExportAccounts(deps.db)) {
    try {
      const result = await runEdoExportPass(deps, account.id, {
        scope: 'all',
        trigger: 'auto',
        maxEvents: limits.maxEvents,
        maxDownloads: limits.maxDownloads,
      });
      if ('skipped' in result) {
        // Учётка занята другой работой — обычное дело, следующий проход через интервал.
        deps.log.info({ accountId: account.id, skipped: result.skipped }, 'выгрузка реестра ЭДО пропущена');
        continue;
      }
      deps.log.info(
        { accountId: account.id, runId: result.runId, outcome: result.outcome, summary: result.summary, retry: result.retry },
        'выгрузка реестра ЭДО завершена',
      );
      if (result.outcome === 'error') report.onError(account.id, result);
      if (await isExportStuck(deps.db, account.id)) report.onStuck(account.id);
    } catch (err) {
      deps.log.error({ accountId: account.id, err }, 'выгрузка реестра ЭДО упала');
      report.onCrash(account.id, err);
    }
  }
}

// ── Состояние реестра для окна подбора ──────────────────────────────────────

export type RegistryAccountState = {
  accountId: string;
  name: string;
  /** Нет ни одного полного прохода / догоняет ленту / давно не проверялся / в порядке. */
  state: 'never' | 'catching_up' | 'stale' | 'ok';
  /** Когда полный проход последний раз дочитал ленту до конца. */
  checkedAt: string | null;
  /** Сбои, которые ещё будут повторены, и ближайший повтор. */
  failedPending: number;
  nextRetryAt: string | null;
  /** Сбои, которые больше не повторяются. */
  failedFinal: number;
};

/**
 * Состояние реестра по каждой активной учётке. «Проверен» — только по полному
 * проходу (`scope = 'all'`), дочитавшему ленту: выгрузка по списку и перепись
 * не отвечают за полноту реестра.
 */
export async function exportRegistryStatus(
  db: Db,
  opts: { intervalSec: number; now?: Date },
): Promise<RegistryAccountState[]> {
  const now = opts.now ?? new Date();
  // Одним запросом: окно подбора открывают часто, а учёток может быть несколько.
  // Подзапросы идут по индексам edo_export_runs_account_idx и
  // edo_export_documents_retry_idx (частичный, только failed).
  const rows = await db.execute<{
    id: string;
    name: string;
    checked_at: Date | string | null;
    last_outcome: string | null;
    last_truncate: string | null;
    pending: number | string;
    final: number | string;
    next_retry_at: Date | string | null;
  }>(drSql`
    select a.id, a.name,
           (select r.feed_completed_at from ${edoExportRuns} r
             where r.edo_account_id = a.id and r.scope = 'all' and r.feed_completed_at is not null
             order by r.started_at desc
             limit 1) as checked_at,
           last.outcome as last_outcome,
           last.truncate_reason as last_truncate,
           (select count(*) from ${edoExportDocuments} d
             where d.edo_account_id = a.id and d.status = 'failed' and d.next_retry_at is not null) as pending,
           (select count(*) from ${edoExportDocuments} d
             where d.edo_account_id = a.id and d.status = 'failed' and d.next_retry_at is null) as final,
           (select min(d.next_retry_at) from ${edoExportDocuments} d
             where d.edo_account_id = a.id and d.status = 'failed') as next_retry_at
      from ${edoAccounts} a
      left join lateral (
        select r.outcome, r.truncate_reason from ${edoExportRuns} r
         where r.edo_account_id = a.id and r.scope = 'all' and r.outcome <> 'running'
         order by r.started_at desc
         limit 1
      ) last on true
     where a.is_active and a.box_id is not null and a.provider = ${DIADOC_PROVIDER}
     order by a.name
  `);

  const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
  return rows.map((row) => {
    const checkedAt = row.checked_at ? new Date(row.checked_at) : null;
    const catchingUp = row.last_outcome === 'truncated' && row.last_truncate === 'limit';
    let state: RegistryAccountState['state'];
    if (!checkedAt) state = catchingUp ? 'catching_up' : 'never';
    else if (now.getTime() - checkedAt.getTime() > 2 * opts.intervalSec * 1000) {
      state = catchingUp ? 'catching_up' : 'stale';
    } else state = 'ok';
    return {
      accountId: row.id,
      name: row.name,
      state,
      checkedAt: checkedAt?.toISOString() ?? null,
      failedPending: Number(row.pending),
      nextRetryAt: iso(row.next_retry_at),
      failedFinal: Number(row.final),
    };
  });
}

export type CensusMatch = {
  /** Сколько документов переписи нашлось и как опознан отправитель. */
  count: number;
  /** Из них без выгружаемой УПД в том же сообщении — «вместо УПД», а не «приложение». */
  withoutUtd: number;
  lastReceivedAt: string | null;
  categories: string[];
  /** Название отправителя, как его прислал Диадок. */
  fromTitle: string | null;
};

/**
 * Документы переписи от поставщика эталона в окне дат. Отправитель опознаётся
 * двумя путями: по ящику (только ящики, через которые в реестре приходил ровно
 * один ИНН, — общие ящики дали бы чужих) и по названию (`FromTitle` через ту же
 * нормализацию, что у подбора).
 */
export async function censusForSupplier(
  db: Db,
  opts: { inns: readonly string[]; names: readonly string[]; from: string; to: string },
): Promise<CensusMatch | null> {
  const names = new Set(opts.names.map(normalizeSupplierName).filter(Boolean));
  if (!opts.inns.length && !names.size) return null;
  const c = edoExportCensus;
  // Окно подбора открывают часто, поэтому сначала — переписанное за окно дат
  // (по осмотру июля — порядка 30 документов в сутки, то есть около двух тысяч
  // строк за ±30 дней, по индексу received_at), и только для их ящиков —
  // проверка по реестру (индекс по ящику). Группировать весь реестр на каждое
  // открытие окна незачем.
  const rows = await db
    .select({
      box: c.counteragentBoxId,
      fromTitle: c.fromTitle,
      category: c.category,
      messageHasUtd: c.messageHasUtd,
      receivedAt: c.receivedAt,
    })
    .from(c)
    .where(
      and(
        drSql`${c.receivedAt} >= ${opts.from}::date`,
        drSql`${c.receivedAt} < (${opts.to}::date + 1)`,
      ),
    );
  if (!rows.length) return null;
  const candidateBoxes = [...new Set(rows.map((row) => row.box).filter((box): box is string => !!box))];
  const boxes =
    opts.inns.length && candidateBoxes.length
      ? await db.execute<{ box: string }>(drSql`
          select counteragent_box_id as box
            from ${edoExportDocuments}
           where counteragent_box_id in (${drSql.join(
             candidateBoxes.map((box) => drSql`${box}`),
             drSql`, `,
           )})
             and supplier_inn is not null
           group by counteragent_box_id
          having count(distinct supplier_inn) = 1
             and min(supplier_inn) in (${drSql.join(
               opts.inns.map((inn) => drSql`${inn}`),
               drSql`, `,
             )})
        `)
      : [];
  const boxIds = new Set(boxes.map((row) => row.box));
  const matched = rows.filter(
    (row) =>
      (row.box !== null && boxIds.has(row.box)) ||
      (row.fromTitle !== null && names.has(normalizeSupplierName(row.fromTitle))),
  );
  if (!matched.length) return null;
  const last = matched.reduce((a, b) =>
    (a.receivedAt?.getTime() ?? 0) >= (b.receivedAt?.getTime() ?? 0) ? a : b,
  );
  return {
    count: matched.length,
    withoutUtd: matched.filter((row) => !row.messageHasUtd).length,
    lastReceivedAt: last.receivedAt?.toISOString() ?? null,
    categories: [...new Set(matched.map((row) => row.category))],
    fromTitle: matched.find((row) => row.fromTitle)?.fromTitle ?? null,
  };
}
