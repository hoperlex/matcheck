// Приём пакета документов: общее ядро для кнопки менеджера и публичной
// страницы поставщика.
//
// Раньше вся эта логика (хеши, идемпотентность, S3, техническая запись,
// постановка в очередь) жила внутри HTTP-хендлера `/upload-documents`. Второй
// канал приёма скопировал бы её целиком, и следующая правка распознавания
// делалась бы дважды. Роуты теперь отвечают только за разбор запроса и коды
// ответа.
//
// Два канала различаются двумя параметрами, а не двумя реализациями:
//
//   dispatch     как задание попадает в BullMQ. `direct` — прежний
//                queue.add после коммита (внутренний путь, поведение не
//                менялось). `outbox` — строка в job_outbox в ТОЙ ЖЕ
//                транзакции: недоступность Redis не оставляет пакет висеть
//                в queued навсегда, доставку повторит consumer воркера.
//
//   concurrency  `legacy` — прежний поиск/перезапуск. `reserve` — протокол
//                резервирования против одновременных запросов: публичный вход
//                открыт всем, две вкладки с одним комплектом реальны.

import { and, asc, eq, isNull, ne, or, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  bundleImportItems,
  counterparties,
  ingestEvents,
  s3CleanupOutbox,
  sites,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import { bundleDispatchKeyOf, enqueueJob, type JobQueue } from '../jobs/job-outbox.js';
import type { RegistryRow } from './bundle-import-registry.js';
import { manualRecipientSource } from './resolve-contractor.js';
import { purgePreviousGeneration, resolveRestartEligibility } from './restart-eligibility.js';
import { loadEnv } from '../../lib/env.js';
import { buildS3Key } from '../storage/s3.path.js';
import { putObject } from '../storage/s3.signer.js';
import { UPD_PARSE_QUEUE } from '../../plugins/queue.js';
import {
  bundleIdentityHashOf,
  contentHashOf,
  expectedDateKeyOf,
  fileHashOf,
  idempotencyKeyOf,
  processingModesHashOf,
  safeName,
} from './bundle-key.js';

export type IngestFile = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  /**
   * Что делать с файлом после приёма:
   *   auto       — классифицировать и распознать, если тип подтверждён;
   *   store_only — файл из зоны «Дополнительные документы»: только сохранить.
   * Необязательное: канал, который про зоны не знает (мобильный клиент), шлёт
   * файлы без режима, и это ровно auto.
   */
  processingMode?: 'auto' | 'store_only';
};

/** Публичная отправка. Данные недоверенные — только аудит и показ. */
export type PublicSubmission = {
  /** Свободный комментарий поставщика к этой поставке; null — не заполнен. */
  comment: string | null;
  ip: string | null;
  userAgent: string | null;
  /**
   * Судьба файлов ИМЕННО ЭТОЙ отправки по входному фильтру.
   *
   * `ordinal` и `sha256` нужны сверке «ни один принятый файл не потерян»: по
   * одному имени запись манифеста со строкой реестра не сопоставить — имена
   * повторяются (IMG_0001.jpg), а одинаковый файл из двух зон схлопывается в
   * одну строку уже ПОСЛЕ сборки манифеста. Поля аддитивные: у отправок,
   * принятых раньше, их просто нет.
   */
  manifest: Array<{
    ordinal: number;
    filename: string;
    accepted: boolean;
    reason?: string;
    /** Только у принятых: у отклонённых буфер не сохраняется. */
    sha256?: string;
  }>;
  /** Непрозрачный идентификатор обращения, который увидит поставщик. */
  ticket: string;
};

export type IngestBundleDeps = {
  db: Db;
  /** Нужна только при dispatch:'direct'. */
  queue: JobQueue;
  log: { error: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export type IngestBundleParams = {
  files: IngestFile[];
  direction: 'inbound' | 'outbound';
  siteId: string;
  contractorId?: string | null;
  recipientMolId?: string | null;
  /** 'YYYY-MM-DD' */
  expectedDate?: string | null;
  actorUserId: string | null;
  dispatch: 'direct' | 'outbox';
  concurrency: 'legacy' | 'reserve';
  publicSubmission?: PublicSubmission | null;
};

/** Файл, принятый формой, но не доехавший до хранилища. */
export type StorageRejectedFile = { filename: string; reason: string };

export type IngestBundleResult =
  | {
      outcome: 'created';
      bundleId: string;
      ticket: string | null;
      /**
       * Файлы, которые форма приняла, а хранилище не взяло. Пустой массив —
       * обычный случай. Непустой означает «принято N из M»: пакет живёт,
       * разбор идёт по дошедшему, а пробел ждёт повторной отправки.
       */
      storageRejected: StorageRejectedFile[];
    }
  | {
      /** Повторная отправка дозаполнила дырку в уже существующем пакете. */
      outcome: 'completed_partial';
      bundleId: string;
      ticket: string | null;
      completedFiles: number;
      storageRejected: StorageRejectedFile[];
    }
  | { outcome: 'reused'; bundleId: string; status: string; ticket: string | null }
  | { outcome: 's3_unavailable'; bundleId: string };

/**
 * Сколько пакет без документов считается «в работе», а не осиротевшим.
 *
 * Между созданием пакета и вставкой технической записи лежит заливка в S3 —
 * десятки секунд на пачке фото. Без этого окна второй одновременный запрос
 * увидел бы пакет без документов, счёл бы его брошенным и залил бы всё заново.
 */
const ORPHAN_GRACE_MS = 60_000;

type BundleRow = typeof sourceBundles.$inferSelect;

/** Совпадает ли scope существующего пакета с текущей загрузкой. */
function scopeMatches(bundle: BundleRow, params: IngestBundleParams): boolean {
  return (
    bundle.siteId === params.siteId &&
    bundle.direction === params.direction &&
    (bundle.contractorId ?? null) === (params.contractorId ?? null) &&
    (bundle.recipientMolId ?? null) === (params.recipientMolId ?? null) &&
    expectedDateKeyOf(bundle.expectedDate) === (params.expectedDate ?? null)
  );
}

/**
 * Пакет-двойник: та же пачка файлов, уже загруженная в ДРУГОМ scope.
 *
 * Нужен только ради пометки менеджеру (`ingest_events.cross_scope_of`) — на
 * приём он не влияет. Раньше такой пакет означал отказ: `bundle_hash` был
 * чистым хешем содержимого под UNIQUE, и второй объект/дата упирались в чужую
 * строку. Теперь дубль содержимого — законная ситуация, поэтому строк с одним
 * `content_hash` бывает несколько и порядок обязан быть детерминированным,
 * иначе ссылка скакала бы от прогона к прогону.
 */
async function findContentTwin(
  db: Db,
  contentHash: string,
  selfBundleId: string,
): Promise<string | null> {
  const [twin] = await db
    .select({ id: sourceBundles.id })
    .from(sourceBundles)
    .where(and(eq(sourceBundles.contentHash, contentHash), ne(sourceBundles.id, selfBundleId)))
    .orderBy(asc(sourceBundles.createdAt), asc(sourceBundles.id))
    .limit(1);
  return twin?.id ?? null;
}

/** Событие приёма публичной отправки. Новая отправка — новое событие и тикет. */
async function recordPublicSubmission(
  db: Db,
  bundleId: string,
  submission: PublicSubmission,
): Promise<void> {
  await db.insert(ingestEvents).values({
    bundleId,
    channel: 'public',
    publicTicket: submission.ticket,
    submissionComment: submission.comment,
    submitterIp: submission.ip,
    submitterUserAgent: submission.userAgent,
    submissionManifest: submission.manifest,
  });
}

/**
 * Ставит ключи в очередь отложенного удаления.
 *
 * Вызывается, когда файлы уже в S3, а запись о них создать не удалось: без
 * этого объекты остались бы в бакете навсегда, никем не связанные.
 */
async function scheduleS3Cleanup(
  db: Db,
  bundleId: string,
  keys: string[],
  log: IngestBundleDeps['log'],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await db.insert(s3CleanupOutbox).values(
      keys.map((s3Key) => ({ s3Key, entityType: 'source-documents', entityId: bundleId })),
    );
  } catch (err) {
    // Последний рубеж: сироты в S3 хуже, чем шумная строка в логе, но
    // ронять из-за них ответ клиенту тоже незачем.
    log.warn({ err, bundleId, keys: keys.length }, 'не удалось запланировать чистку S3');
  }
}

type HashedFile = IngestFile & { fileHash: string; processingMode: 'auto' | 'store_only' };

/** Файл, доехавший до хранилища. `ordinal` — его место в пачке (0-based). */
type UploadedFile = {
  ordinal: number;
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  processingMode: 'auto' | 'store_only';
  sha256: string;
};

/** Файл, который принят формой, но в хранилище не лёг. Ключа у него нет. */
type RejectedFile = {
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  processingMode: 'auto' | 'store_only';
  sha256: string;
  error: unknown;
};

/**
 * Кладёт файлы пачки в хранилище, не останавливаясь на первом отказе.
 *
 * Возвращает оба списка. Вызывающий решает, что делать с частичным исходом, —
 * и решение это разное: при первичном приёме недоехавший файл превращается в
 * строку реестра «не загружен», при дозагрузке остаётся ждать следующей попытки.
 *
 * Хеш уезжает в метаданные объекта — но только при `S3_OBJECT_CHECKSUM=1`.
 * Строка реестра говорит, что мы приняли, а `x-amz-meta-sha256` — что в бакете
 * действительно лежит. По умолчанию флаг выключен: заголовок стандартный, но на
 * нашем провайдере не проверен, а приём пачки ронять нельзя. Дозагрузку
 * недостающих файлов это не затрагивает — она сверяется с хешем из реестра.
 */
async function putBundleFiles(args: {
  entries: Array<{ file: HashedFile; ordinal: number }>;
  bundleId: string;
  site: { code: string } | null;
  counterparty: { inn: string; name: string } | null;
}): Promise<{ uploaded: UploadedFile[]; rejected: RejectedFile[] }> {
  const results = await Promise.allSettled(
    args.entries.map(async ({ file, ordinal }) => {
      const name = safeName(file.filename, ordinal);
      const s3Key = buildS3Key({
        site: args.site,
        counterparty: args.counterparty,
        entityType: 'source-documents',
        entityId: args.bundleId,
        filename: `doc-${ordinal + 1}-${name}`,
      });
      await putObject(
        s3Key,
        file.buffer,
        file.mimeType || 'application/octet-stream',
        loadEnv().S3_OBJECT_CHECKSUM ? { sha256: file.fileHash } : undefined,
      );
      return {
        ordinal,
        s3Key,
        filename: name,
        mimeType: file.mimeType || 'application/octet-stream',
        sizeBytes: file.buffer.length,
        processingMode: file.processingMode,
        sha256: file.fileHash,
      } satisfies UploadedFile;
    }),
  );

  const uploaded: UploadedFile[] = [];
  const rejected: RejectedFile[] = [];
  results.forEach((r, i) => {
    const entry = args.entries[i];
    if (!entry) return;
    if (r.status === 'fulfilled') {
      uploaded.push(r.value);
      return;
    }
    rejected.push({
      ordinal: entry.ordinal,
      filename: safeName(entry.file.filename, entry.ordinal),
      mimeType: entry.file.mimeType || 'application/octet-stream',
      sizeBytes: entry.file.buffer.length,
      processingMode: entry.file.processingMode,
      sha256: entry.file.fileHash,
      error: r.reason,
    });
  });
  return { uploaded, rejected };
}

/**
 * Один и тот же файл, попавший в ОБЕ зоны формы, сводится к `store_only`.
 *
 * Иначе в бакет лягут две копии одних байтов, а в реестре появятся две строки
 * на один документ — и вторая из них ещё и уедет на распознавание. UI такого не
 * допускает, но приём открыт наружу и полагаться на клиента нельзя.
 *
 * Дубли ВНУТРИ одной зоны не трогаем: их поведение прежнее, а схлопывание
 * изменило бы content_hash и разорвало узнавание ранее загруженных пакетов.
 */
function mergeSameFileAcrossZones(files: readonly IngestFile[]): HashedFile[] {
  const hashed: HashedFile[] = files.map((f) => ({
    ...f,
    fileHash: fileHashOf(f.buffer),
    processingMode: f.processingMode ?? 'auto',
  }));

  const mixed = new Set<string>();
  const modes = new Map<string, Set<string>>();
  for (const f of hashed) {
    const seen = modes.get(f.fileHash) ?? new Set<string>();
    seen.add(f.processingMode);
    modes.set(f.fileHash, seen);
    if (seen.size > 1) mixed.add(f.fileHash);
  }
  if (mixed.size === 0) return hashed;

  const kept = new Set<string>();
  return hashed.flatMap((f) => {
    if (!mixed.has(f.fileHash)) return [f];
    if (kept.has(f.fileHash)) return [];
    kept.add(f.fileHash);
    return [{ ...f, processingMode: 'store_only' as const }];
  });
}

/** Объект и контрагент — то, из чего строится путь в бакете. */
async function resolveKeyScope(
  db: Db,
  siteId: string | null,
  contractorId: string | null,
): Promise<{
  site: { code: string } | null;
  counterparty: { inn: string; name: string } | null;
}> {
  const [site] = siteId
    ? await db.select({ code: sites.code }).from(sites).where(eq(sites.id, siteId)).limit(1)
    : [];
  const [cp] = contractorId
    ? await db
        .select({ inn: counterparties.inn, name: counterparties.name })
        .from(counterparties)
        .where(eq(counterparties.id, contractorId))
        .limit(1)
    : [];
  return { site: site ?? null, counterparty: cp ?? null };
}

/**
 * Сопоставляет файлы повторной отправки со строками, чей объект не долетел до S3.
 *
 * Сначала по хешу содержимого — единственный признак, который не врёт: имена у
 * поставщиков повторяются пачками (IMG_0431.jpg), а порядок человек меняет,
 * перекладывая файлы в форме. Одинаковых файлов может быть несколько, поэтому
 * хеш ведёт к ОЧЕРЕДИ строк, и каждый файл забирает из неё первую свободную.
 *
 * Запасной путь — имя плюс позиция в пачке: он нужен строкам, принятым до
 * появления хеша, и отправкам, где поставщик пересохранил файл (байты
 * изменились, документ тот же).
 */
export function matchFilesToMissingRows(
  files: HashedFile[],
  rows: RegistryRow[],
): Array<{ file: HashedFile; row: RegistryRow }> {
  const byHash = new Map<string, RegistryRow[]>();
  for (const r of rows) {
    if (!r.contentSha256) continue;
    const queue = byHash.get(r.contentSha256) ?? [];
    queue.push(r);
    byHash.set(r.contentSha256, queue);
  }

  const taken = new Set<string>();
  const matched: Array<{ file: HashedFile; row: RegistryRow }> = [];
  const unmatchedFiles: Array<{ file: HashedFile; ordinal: number }> = [];

  files.forEach((file, ordinal) => {
    const queue = byHash.get(file.fileHash);
    const row = queue?.find((r) => !taken.has(r.id));
    if (row) {
      taken.add(row.id);
      matched.push({ file, row });
      return;
    }
    unmatchedFiles.push({ file, ordinal });
  });

  // Запасной путь для тех, кого хеш не нашёл.
  for (const { file, ordinal } of unmatchedFiles) {
    const row = rows.find(
      (r) => !taken.has(r.id) && r.filename === safeName(file.filename, ordinal) && r.inputOrder === ordinal,
    );
    if (!row) continue;
    taken.add(row.id);
    matched.push({ file, row });
  }

  return matched;
}

/**
 * Дозагружает файлы, которые в прошлый раз не легли в хранилище.
 *
 * Ничего не удаляет и не поднимает поколение загрузки: пакет тот же, документы
 * уже принятых файлов на месте, в реестре просто дырка. Это и отличает
 * дозагрузку от рестарта, который начинает поколение заново и сносит прошлые
 * документы (purgePreviousGeneration).
 *
 * Поднимается только `dispatch_generation` — иначе задание разбора не
 * поставится: его ключ дедупликации совпал бы с уже выполненным.
 */
async function completePartialUpload(
  deps: IngestBundleDeps,
  params: IngestBundleParams,
  bundle: BundleRow,
  missingRows: RegistryRow[],
  hashed: HashedFile[],
): Promise<IngestBundleResult> {
  const { db, log } = deps;
  const publicSubmission = params.publicSubmission ?? null;
  const matched = matchFilesToMissingRows(hashed, missingRows);

  if (matched.length === 0) {
    // Прислали что-то другое: ни один файл не подошёл к дырке. Пакет не
    // трогаем — иначе повторная отправка чужого комплекта затёрла бы реестр.
    log.warn(
      { bundleId: bundle.id, missing: missingRows.length },
      'приём пачки: повторная отправка не содержит недостающих файлов',
    );
    if (publicSubmission) await recordPublicSubmission(db, bundle.id, publicSubmission);
    return {
      outcome: 'reused',
      bundleId: bundle.id,
      status: bundle.status,
      ticket: publicSubmission?.ticket ?? null,
    };
  }

  const scope = await resolveKeyScope(db, bundle.siteId, bundle.contractorId ?? null);
  const { uploaded, rejected } = await putBundleFiles({
    entries: matched.map(({ file, row }) => ({
      file,
      // Позиция из реестра, а не из текущей отправки: порядок страниц задан
      // первой загрузкой, и менять его нельзя — по нему собираются УПД.
      ordinal: row.inputOrder ?? 0,
    })),
    bundleId: bundle.id,
    site: scope.site,
    counterparty: scope.counterparty,
  });

  const rowByOrdinal = new Map(matched.map(({ row }) => [row.inputOrder ?? 0, row]));
  let completed = 0;
  for (const file of uploaded) {
    const row = rowByOrdinal.get(file.ordinal);
    if (!row) continue;
    // Ключ и статус — ОДНИМ обновлением: состояния «ключ уже есть, а строка ещё
    // failed» существовать не должно, иначе параллельный проход увидит файл
    // одновременно и потерянным, и загруженным.
    //
    // Условие `input_s3_key is null` — CAS: если вторая вкладка успела
    // дозагрузить тот же файл, наш UPDATE ничего не изменит, и мы не перепишем
    // чужой ключ на свой, оставив объект-сироту.
    const done = await db
      .update(bundleImportItems)
      .set({
        inputS3Key: file.s3Key,
        status: 'accepted',
        effectiveStatus: null,
        reason: null,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        contentSha256: file.sha256,
        updatedAt: new Date(),
      })
      .where(and(eq(bundleImportItems.id, row.id), isNull(bundleImportItems.inputS3Key)))
      .returning({ id: bundleImportItems.id });
    if (done.length > 0) {
      completed++;
    } else {
      // Гонку проиграли — объект наш, а ссылки на него нет. В бакете он не
      // нужен: строку держит ключ победителя.
      await scheduleS3Cleanup(db, bundle.id, [file.s3Key], log);
    }
  }

  if (completed === 0) {
    if (publicSubmission) await recordPublicSubmission(db, bundle.id, publicSubmission);
    return {
      outcome: 'reused',
      bundleId: bundle.id,
      status: bundle.status,
      ticket: publicSubmission?.ticket ?? null,
    };
  }

  // Разбор надо запустить заново: дозагруженные строки лежат в `accepted`, а
  // router пропускает только терминальные. Поколение ЗАДАНИЯ растёт, поколение
  // ЗАГРУЗКИ — нет: файлы те же самые, реестр тот же.
  const [bumped] = await db
    .update(sourceBundles)
    .set({
      status: 'queued',
      parseErrorCode: null,
      parseErrorMessage: null,
      dispatchGeneration: drSql`${sourceBundles.dispatchGeneration} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sourceBundles.id, bundle.id))
    .returning();

  const dispatchGeneration = bumped?.dispatchGeneration ?? bundle.dispatchGeneration;
  const jobId = bundleDispatchKeyOf(bundle.id, dispatchGeneration);
  await db.transaction(async (tx) => {
    await tx
      .update(sourceBundles)
      .set({ jobId })
      .where(
        and(eq(sourceBundles.id, bundle.id), eq(sourceBundles.dispatchGeneration, dispatchGeneration)),
      );

    if (publicSubmission) {
      await tx.insert(ingestEvents).values({
        bundleId: bundle.id,
        channel: 'public',
        publicTicket: publicSubmission.ticket,
        submissionComment: publicSubmission.comment,
        submitterIp: publicSubmission.ip,
        submitterUserAgent: publicSubmission.userAgent,
        submissionManifest: publicSubmission.manifest,
      });
    }
    if (params.dispatch === 'outbox') {
      await enqueueJob(tx as unknown as Db, {
        queue: UPD_PARSE_QUEUE,
        jobName: 'parse',
        payload: { bundleId: bundle.id, mode: 'router', bundleGeneration: dispatchGeneration },
        dedupeKey: jobId,
      });
    }
  });
  if (params.dispatch === 'direct') {
    await deps.queue.add(
      'parse',
      { bundleId: bundle.id, mode: 'router', bundleGeneration: dispatchGeneration } as never,
      { jobId },
    );
  }

  log.warn(
    { bundleId: bundle.id, completed, stillMissing: rejected.length },
    'приём пачки: дозагружены файлы, не дошедшие до хранилища в прошлый раз',
  );

  return {
    outcome: 'completed_partial',
    bundleId: bundle.id,
    ticket: publicSubmission?.ticket ?? null,
    completedFiles: completed,
    storageRejected: rejected.map((r) => ({
      filename: r.filename,
      reason: 'файл снова не загрузился в хранилище',
    })),
  };
}

export async function ingestDocumentsBundle(
  deps: IngestBundleDeps,
  params: IngestBundleParams,
): Promise<IngestBundleResult> {
  const { db, log } = deps;
  const { files, direction, siteId, publicSubmission } = params;
  const contractorId = params.contractorId ?? null;
  const recipientMolId = params.recipientMolId ?? null;
  const expectedDate = params.expectedDate ?? null;
  const reserve = params.concurrency === 'reserve';

  const hashed = mergeSameFileAcrossZones(files);
  const contentHash = contentHashOf(hashed.map((f) => f.fileHash));
  const idempotencyKey = idempotencyKeyOf({
    siteId,
    direction,
    contractorId,
    recipientMolId,
    expectedDate,
    contentHash,
    modesHash: processingModesHashOf(hashed),
  });
  // Идентичность пакета = scope + содержимое. Раньше в bundle_hash писали
  // чистый contentHash, и та же пачка на другой объект/дату упиралась в чужую
  // строку под UNIQUE — приходил отказ, даже если документы прежнего пакета
  // давно удалили.
  const identityHash = bundleIdentityHashOf(idempotencyKey);

  // ─── 1. Поиск существующего пакета ────────────────────────────────────────
  //
  // Три шага, и все три — про ОДИН И ТОТ ЖЕ scope. Пакет другого объекта или
  // другой даты здесь больше не рассматривается вовсе: он законно существует
  // отдельно.
  let existing: BundleRow | undefined;
  const [byKey] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.idempotencyKey, idempotencyKey))
    .limit(1);
  existing = byKey;

  // Страховка от гонки: ключ мог не записаться, а identity-строка уже есть.
  // Ключ при этом дозаполняем — иначе следующая загрузка не увидит пакет по
  // ключу, а вставка упрётся в UNIQUE по bundle_hash и получит 23505 вместо
  // мирного «проиграл гонку».
  if (!existing) {
    const [byIdentity] = await db
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.bundleHash, identityHash))
      .limit(1);
    if (byIdentity) {
      if (!byIdentity.idempotencyKey) {
        await db
          .update(sourceBundles)
          .set({ idempotencyKey, contentHash })
          .where(and(eq(sourceBundles.id, byIdentity.id), isNull(sourceBundles.idempotencyKey)));
      }
      existing = byIdentity;
    }
  }

  // Legacy: пакеты, загруженные до перевода writers на scoped-ключ. У них и
  // ключ, и content_hash пустые, а bundle_hash хранит ЧИСТЫЙ хеш содержимого —
  // найти их можно только так. Условие сужено намеренно: `/upload-waybill`
  // тоже пишет bundle_hash без ключей, и без фильтра ручная загрузка
  // переиспользовала бы пакет накладных.
  if (!existing) {
    const [legacy] = await db
      .select()
      .from(sourceBundles)
      .where(
        and(
          eq(sourceBundles.bundleHash, contentHash),
          isNull(sourceBundles.idempotencyKey),
          eq(sourceBundles.kind, 'mixed'),
          isNull(sourceBundles.parentBundleId),
        ),
      )
      .limit(1);
    // Чужой scope — не наш пакет: молча создадим свой.
    if (legacy && scopeMatches(legacy, params)) {
      await db
        .update(sourceBundles)
        .set({ idempotencyKey, contentHash })
        .where(and(eq(sourceBundles.id, legacy.id), isNull(sourceBundles.idempotencyKey)));
      existing = legacy;
    }
  }

  // ─── 2. Пакет уже есть — решаем, есть ли по нему работа ───────────────────
  //
  // Раньше здесь стояло «есть хотя бы один документ → отработан». Этого мало:
  // при частичном удалении (менеджер убрал одну УПД из пачки) живой документ у
  // пакета оставался, и удалённая не восстанавливалась никогда, а поставщику
  // отвечали 201 «принято». Теперь решение принимает resolveRestartEligibility,
  // и «ничего не делаем» — это три разных причины, различимые в логе.
  if (existing) {
    const eligibility = await resolveRestartEligibility(db, existing);
    if (eligibility.action === 'reuse') {
      // Занятость операцией — единственная причина, которую стоит видеть в
      // логе: поставщик прислал комплект повторно, а восстановить его нельзя,
      // потому что документы уже в приёмке. Остальные два случая штатны.
      if (eligibility.reason === 'locked_by_operation') {
        log?.warn(
          { bundleId: existing.id, documents: eligibility.operationDocumentIds },
          'приём пачки: комплект неполон, но документы уже в операции — не восстанавливаем',
        );
      }
      if (publicSubmission) await recordPublicSubmission(db, existing.id, publicSubmission);
      return {
        outcome: 'reused',
        bundleId: existing.id,
        status: existing.status,
        ticket: publicSubmission?.ticket ?? null,
      };
    }
    // Часть файлов прошлой отправки не легла в хранилище. Дозагружаем ровно их
    // — ни поколение, ни уже разобранные документы не трогаем. Проверка стоит
    // ДО рестарта намеренно: рестарт снёс бы девять принятых документов ради
    // одного пропущенного файла.
    if (eligibility.action === 'complete_partial') {
      return completePartialUpload(deps, params, existing, eligibility.missingRows, hashed);
    }
    log?.warn(
      { bundleId: existing.id, missingFiles: eligibility.missingFiles },
      'приём пачки: комплект неполон — восстанавливаем новым поколением загрузки',
    );
  }

  // ─── 3. Резервирование пакета ─────────────────────────────────────────────
  const now = new Date();
  const bundleValues = {
    kind: 'mixed' as const,
    direction,
    siteId,
    contractorId,
    recipientMolId,
    expectedDate: expectedDate ? new Date(expectedDate) : null,
    status: 'queued' as const,
    parseErrorCode: null,
    parseErrorMessage: null,
    docCount: 0,
  };

  let bundle: BundleRow;
  let generation: number;

  if (existing) {
    // Пакет есть, документов нет: либо его бросили (сбой воркера, ручная
    // чистка), либо параллельный запрос прямо сейчас льёт файлы в S3.
    //
    // Окно ORPHAN_GRACE_MS различает эти два случая по возрасту записи, но у
    // него был провал: неудачная заливка помечает пакет `parse_failed` и при
    // этом обновляет updated_at (см. шаг 4). Поставщик, нажавший «отправить ещё
    // раз» сразу после ошибки, попадал в «свежий пакет — значит им занят
    // кто-то другой» и получал reused, то есть 201 «принято» на пустоту:
    // успевшие объекты к тому моменту уже уехали в очередь на удаление.
    // `parse_failed` — это не «кто-то другой льёт прямо сейчас», а
    // зафиксированный отказ, поэтому такой пакет перезапускаем немедленно.
    // Сюда мы попадаем только с пакетом, по которому есть работа: иначе шаг 2
    // вернул бы reused выше.
    //
    // ПОКОЛЕНИЕ ЗАГРУЗКИ РАСТЁТ ЗДЕСЬ, и это не то же самое, что
    // dispatch_generation.
    //
    // dispatch_generation — поколение ЗАДАНИЯ, оно защищает от повторной
    // доставки старого job. active_upload_generation — поколение ЗАГРУЗКИ: по
    // нему живут строки реестра, ключ дочернего пакета сборки
    // (`assembly:<root>:<generation>`), ключи дочерних пакетов накладных и гейт
    // публикации. До этой правки оно не инкрементировалось НИГДЕ — только
    // читалось, и у всех пакетов оставалось нулём.
    //
    // Из-за этого повторная отправка того же комплекта попадала в мёртвую зону:
    // хеш дочернего пакета совпадал с прошлым, вставка гасилась
    // onConflictDoNothing, задание сборки не ставилось вовсе, и файлы получали
    // заглушки «не распознано» при нуле попыток разбора.
    //
    // Инкремент здесь же переводит корень в staging без отдельного действия:
    // published_generation остаётся на прошлом номере, а раз группа видна только
    // при published_generation = active_upload_generation, документы прошлого
    // поколения перестают быть видимыми в тот же момент.
    const restart = reserve
      ? await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
            dispatchGeneration: drSql`${sourceBundles.dispatchGeneration} + 1`,
            activeUploadGeneration: drSql`${sourceBundles.activeUploadGeneration} + 1`,
            createdByUserId: params.actorUserId ?? existing.createdByUserId,
            updatedAt: now,
          })
          .where(
            and(
              eq(sourceBundles.id, existing.id),
              or(
                drSql`${sourceBundles.updatedAt} < now() - make_interval(secs => ${ORPHAN_GRACE_MS / 1000})`,
                eq(sourceBundles.status, 'parse_failed'),
              ),
            ),
          )
          .returning()
      : await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
            // Тот же инкремент, что и в reserve-ветке: внутренняя загрузка
            // «Загрузить документы» проходит здесь, и оставить её на прежнем
            // поколении значило бы сохранить мёртвую зону для половины входов.
            activeUploadGeneration: drSql`${sourceBundles.activeUploadGeneration} + 1`,
            createdByUserId: params.actorUserId ?? existing.createdByUserId,
            updatedAt: now,
          })
          .where(eq(sourceBundles.id, existing.id))
          .returning();

    const [updated] = restart;
    if (!updated) {
      // CAS не сработал: пакет свежий, значит им занят кто-то другой.
      // Повторная заливка тех же файлов только удвоила бы работу.
      if (publicSubmission) await recordPublicSubmission(db, existing.id, publicSubmission);
      return {
        outcome: 'reused',
        bundleId: existing.id,
        status: existing.status,
        ticket: publicSubmission?.ticket ?? null,
      };
    }
    // Пакет пересобирается с нуля, поэтому остатки прошлого поколения уходят.
    //
    // Без этого рестарт задваивает документы: реестр нового поколения заводится
    // на ВСЕ файлы пачки, router разберёт каждый, и уцелевшие документы прошлого
    // прогона останутся рядом с новыми. Инвариант видимости такого не ловит — он
    // спрашивает «есть ли документ по s3Key», а документ есть.
    //
    // Безопасно ровно потому, что сюда мы дошли с вердиктом `restart`: ни один
    // документ не привязан к операции и разбор не идёт.
    const purged = await db.transaction((tx) => purgePreviousGeneration(tx, existing.id));
    if (purged.length > 0) {
      log?.warn(
        { bundleId: existing.id, documents: purged.length },
        'приём пачки: документы прошлого поколения удалены перед пересбором',
      );
    }

    bundle = updated;
    generation = updated.dispatchGeneration;
  } else {
    // Конфликт подавляем по idempotency_key: он канонический и уникален
    // частичным индексом. По bundle_hash подавлять нельзя — при выкате старый
    // и новый код считают его по-разному, и одновременные запросы получили бы
    // не «проигрыш в гонке», а 23505. Ключ же обе версии считают одинаково.
    // Подавление ставится в ОБА режима: во внутреннем его не было вовсе.
    const insertValues = {
      bundleHash: identityHash,
      contentHash,
      idempotencyKey,
      ...bundleValues,
      createdByUserId: params.actorUserId,
    };
    const inserted = await db
      .insert(sourceBundles)
      .values(insertValues)
      // where — предикат ЧАСТИЧНОГО индекса, без него Postgres не сопоставит
      // конфликт с `... WHERE idempotency_key IS NOT NULL`.
      .onConflictDoNothing({
        target: sourceBundles.idempotencyKey,
        where: drSql`${sourceBundles.idempotencyKey} is not null`,
      })
      .returning();

    const [created] = inserted;
    if (!created) {
      // Гонку выиграл другой запрос — он в том же scope по построению ключа,
      // поэтому проверять scope больше не нужно.
      const [winner] = await db
        .select()
        .from(sourceBundles)
        .where(eq(sourceBundles.idempotencyKey, idempotencyKey))
        .limit(1);
      if (!winner) throw new Error('ingest: пакет исчез после конфликта вставки');
      if (publicSubmission) await recordPublicSubmission(db, winner.id, publicSubmission);
      return {
        outcome: 'reused',
        bundleId: winner.id,
        status: winner.status,
        ticket: publicSubmission?.ticket ?? null,
      };
    }
    bundle = created;
    generation = created.dispatchGeneration;
  }

  // ─── 4. Файлы в S3 ────────────────────────────────────────────────────────
  const [site] = await db
    .select({ code: sites.code })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  const [cp] = contractorId
    ? await db
        .select({ inn: counterparties.inn, name: counterparties.name })
        .from(counterparties)
        .where(eq(counterparties.id, contractorId))
        .limit(1)
    : [];

  const { uploaded: succeeded, rejected } = await putBundleFiles({
    entries: hashed.map((file, ordinal) => ({ file, ordinal })),
    bundleId: bundle.id,
    site: site ?? null,
    counterparty: cp ?? null,
  });

  // Не дошло НИЧЕГО — хранилище недоступно целиком. Прежнее поведение: убрать
  // за собой и честно ответить отказом, чтобы поставщик повторил отправку.
  if (succeeded.length === 0) {
    if (rejected.length > 0) log.error({ err: rejected[0]?.error }, 's3 putObject failed');
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'internal_error',
        parseErrorMessage: 's3_unavailable',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundle.id));
    return { outcome: 's3_unavailable', bundleId: bundle.id };
  }

  // Часть файлов не дошла. Раньше это бракова́ло приём целиком: успевшие девять
  // объектов уезжали в очередь на удаление ради одного упавшего, и поставщик
  // заливал всё заново. Теперь дошедшее остаётся, а по недошедшему заводится
  // строка реестра БЕЗ ключа S3 — «принят формой, в хранилище не лёг».
  //
  // Ключ не выдумываем: объекта нет, и строка с ключом означала бы ссылку в
  // пустоту — портал предложил бы открыть файл, а S3 вернул бы 404. По той же
  // причине такая строка не проходит через selectRegistryRows: разбирать
  // нечего.
  //
  // Машину это не выпускает наружу: строка без документа держит группу
  // незавершённой (GROUP_IS_COMPLETE), пока файл не дозагрузят.
  if (rejected.length > 0) {
    log.error(
      { err: rejected[0]?.error, bundleId: bundle.id, rejected: rejected.length },
      's3 putObject failed — часть файлов пакета не принята',
    );
  }

  // Та же пачка уже загружена в другом scope? Приём это не останавливает —
  // раньше здесь был отказ 409, из-за которого нельзя было загрузить файл,
  // удалённый из системы. Теперь просто оставляем менеджеру ссылку на двойник.
  const twinBundleId = await findContentTwin(db, contentHash, bundle.id);

  // ─── 5. Записи о пакете + задание ─────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const stamp = new Date();
      const [tech] = await tx
        .insert(sourceDocuments)
        .values({
          kind: 'transport_waybill',
          // Служебная запись пакета: воркер удалит её и развернёт реальные
          // документы. Из /sync, списка и экспорта исключается по флагу.
          isTechnical: true,
          direction,
          origin: 'manual_pdf',
          contractorId,
          recipientMolId,
          // Получателя задал человек в форме загрузки — фиксируем это, чтобы
          // автоподстановка считала документ уже решённым, а не нетронутым.
          recipientSource: manualRecipientSource({ direction, contractorId, recipientMolId }),
          siteId,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          status: 'queued',
          contentHash,
          originalFilename: files[0]?.filename ?? null,
          queuedAt: stamp,
          parsedAt: stamp,
          bundleId: bundle.id,
          createdByUserId: params.actorUserId,
        })
        .returning();
      if (!tech) throw new Error('ingest: не удалось создать техническую запись пакета');

      await tx.insert(sourceDocumentAttachments).values(
        succeeded.map((a) => ({
          sourceDocumentId: tech.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original' as const,
        })),
      );

      // Реестр входных файлов заводится ЗДЕСЬ, а не воркером при разборе.
      //
      // Причина — идемпотентность. Строки, созданные воркером, поколения не
      // имеют, а служебная запись после разбора удаляется: повторный
      // router-job не нашёл бы ни реестра, ни attachments и переклассифицировал
      // бы всё заново, включая файлы, которые распознавать не просили. Строка,
      // созданная в одной транзакции с документами, переживает и разбор, и
      // удаление служебной записи.
      //
      // DELETE перед вставкой — про рестарт брошенного пакета: сюда приём
      // попадает только если пакет НЕ признан обработанным, значит строки
      // прошлой попытки этого же поколения не в счёт. Без него вставка упёрлась
      // бы в bundle_import_items_input_file_unique (ключи S3 при повторной
      // заливке те же), а строка `created` от удалённого документа заставила бы
      // router пропустить файл как терминальный.
      await tx
        .delete(bundleImportItems)
        .where(
          and(
            eq(bundleImportItems.bundleId, bundle.id),
            eq(bundleImportItems.uploadGeneration, bundle.activeUploadGeneration),
          ),
        );
      await tx.insert(bundleImportItems).values([
        ...succeeded.map((a) => ({
          bundleId: bundle.id,
          sourceFilename: a.filename,
          inputS3Key: a.s3Key,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          contentSha256: a.sha256,
          uploadGeneration: bundle.activeUploadGeneration,
          // Порядок файлов в пачке — здесь единственное место, где он ещё
          // известен. Дальше по реестру его не восстановить: у фотографий
          // страниц одной УПД нет ни номеров, ни имён, по которым можно было бы
          // понять, какая за какой, а порядок выборки из БД ничем не задан.
          // Сборка логических документов опирается именно на него.
          //
          // Позиция В ИСХОДНОЙ ПАЧКЕ, а не в списке успешных: при частичном
          // сбое второй файл мог не долететь, и нумерация «по порядку в
          // succeeded» сдвинула бы третий на его место — страницы одной УПД
          // разъехались бы после дозагрузки.
          inputOrder: a.ordinal,
          processingMode: a.processingMode,
          status: 'accepted' as const,
        })),
        // Файлы, не дошедшие до хранилища. Ключа нет — есть имя, порядок и
        // хеш: этого хватит, чтобы показать пробел менеджеру и узнать файл при
        // повторной отправке.
        ...rejected.map((a) => ({
          bundleId: bundle.id,
          sourceFilename: a.filename,
          inputS3Key: null,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          contentSha256: a.sha256,
          uploadGeneration: bundle.activeUploadGeneration,
          inputOrder: a.ordinal,
          processingMode: a.processingMode,
          status: 'failed' as const,
          effectiveStatus: 'failed' as const,
          reason: 'файл не загрузился в хранилище — требуется повторная отправка',
        })),
      ]);

      if (publicSubmission) {
        await tx.insert(ingestEvents).values({
          bundleId: bundle.id,
          channel: 'public',
          publicTicket: publicSubmission.ticket,
          submissionComment: publicSubmission.comment,
          submitterIp: publicSubmission.ip,
          submitterUserAgent: publicSubmission.userAgent,
          submissionManifest: publicSubmission.manifest,
          crossScopeOf: twinBundleId,
        });
      } else if (twinBundleId) {
        // Внутренняя загрузка событий обычно не пишет — сам факт виден по
        // created_by_user_id пакета. Но ссылку на двойник хранить больше негде,
        // а раньше об этом случае сообщал отказ 409.
        await tx.insert(ingestEvents).values({
          bundleId: bundle.id,
          channel: 'manual',
          actorUserId: params.actorUserId,
          crossScopeOf: twinBundleId,
        });
      }

      const jobId = bundleDispatchKeyOf(bundle.id, generation);
      await tx
        .update(sourceBundles)
        .set({ jobId })
        .where(
          and(eq(sourceBundles.id, bundle.id), eq(sourceBundles.dispatchGeneration, generation)),
        );

      if (params.dispatch === 'outbox') {
        // Приведение как в domain/mail/resolve-message.ts: тип транзакции
        // drizzle структурно не совпадает с Db, хотя API идентичен.
        await enqueueJob(tx as unknown as Db, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: { bundleId: bundle.id, mode: 'router', bundleGeneration: generation },
          dedupeKey: jobId,
        });
      }
    });
  } catch (err) {
    // Файлы уже в S3, а ссылок на них не появилось — убираем за собой.
    await scheduleS3Cleanup(db, bundle.id, succeeded.map((a) => a.s3Key), log);
    throw err;
  }

  if (params.dispatch === 'direct') {
    // Прежнее поведение внутреннего входа: недоступность Redis поднимается
    // наверх как ошибка запроса.
    const jobId = bundleDispatchKeyOf(bundle.id, generation);
    await deps.queue.add(
      'parse',
      { bundleId: bundle.id, mode: 'router', bundleGeneration: generation } as never,
      { jobId },
    );
  }

  return {
    outcome: 'created',
    bundleId: bundle.id,
    ticket: publicSubmission?.ticket ?? null,
    storageRejected: rejected.map((r) => ({
      filename: r.filename,
      reason: 'файл не загрузился в хранилище — отправьте его ещё раз',
    })),
  };
}
