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

import { and, asc, eq, isNull, ne, sql as drSql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import { selectRegistryRows } from './bundle-import-registry.js';
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
import { manualRecipientSource } from './resolve-contractor.js';
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

export type IngestBundleResult =
  | { outcome: 'created'; bundleId: string; ticket: string | null }
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
 * Пакет уже отработан — новой работы по нему нет.
 *
 * Два основания, и второе появилось вместе с зоной «Дополнительные документы».
 *
 * 1. У пакета есть документ — на нём самом или в ДОЧЕРНЕМ пакете. Дочерний
 *    нужен потому, что накладные router разворачивает в отдельный пакет, и
 *    реальный документ ТН/ОС-2 висит уже на нём: без этой ветки повторная
 *    отправка тех же накладных заливала бы их заново.
 * 2. Документов нет вовсе, но пачка разобрана и КАЖДЫЙ её файл сохранён без
 *    распознавания. Так выглядит поставка из одних сертификатов: документов она
 *    не создаёт, а техническая запись после разбора удаляется — без этой ветки
 *    такая пачка при каждой отправке считалась бы брошенной и лилась заново.
 *
 * Чего здесь намеренно НЕТ: пофайлового восстановления. Если один документ
 * пачки жив, а второй менеджер удалил, повторная загрузка второй не воссоздаст —
 * ровно как и до появления этой функции.
 */
async function bundleAlreadyProcessed(db: Db, bundle: BundleRow): Promise<boolean> {
  const [own] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.bundleId, bundle.id))
    .limit(1);
  if (own) return true;

  const child = alias(sourceBundles, 'child_bundle');
  const [inChild] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .innerJoin(child, eq(child.id, sourceDocuments.bundleId))
    .where(eq(child.parentBundleId, bundle.id))
    .limit(1);
  if (inChild) return true;

  if (bundle.status !== 'parsed') return false;
  const rows = await selectRegistryRows(db, bundle.id, bundle.activeUploadGeneration);
  return rows.length > 0 && rows.every((r) => r.status === 'skipped');
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

  // ─── 2. Пакет уже есть и разобран — новой работы нет ──────────────────────
  if (existing && (await bundleAlreadyProcessed(db, existing))) {
    if (publicSubmission) await recordPublicSubmission(db, existing.id, publicSubmission);
    return {
      outcome: 'reused',
      bundleId: existing.id,
      status: existing.status,
      ticket: publicSubmission?.ticket ?? null,
    };
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
    const restart = reserve
      ? await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
            dispatchGeneration: drSql`${sourceBundles.dispatchGeneration} + 1`,
            createdByUserId: params.actorUserId ?? existing.createdByUserId,
            updatedAt: now,
          })
          .where(
            and(
              eq(sourceBundles.id, existing.id),
              drSql`${sourceBundles.updatedAt} < now() - make_interval(secs => ${ORPHAN_GRACE_MS / 1000})`,
            ),
          )
          .returning()
      : await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
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

  const uploads = await Promise.allSettled(
    hashed.map(async (f, i) => {
      const name = safeName(f.filename, i);
      const s3Key = buildS3Key({
        site: site ?? null,
        counterparty: cp ?? null,
        entityType: 'source-documents',
        entityId: bundle.id,
        filename: `doc-${i + 1}-${name}`,
      });
      await putObject(s3Key, f.buffer, f.mimeType || 'application/octet-stream');
      return {
        s3Key,
        filename: name,
        mimeType: f.mimeType || 'application/octet-stream',
        sizeBytes: f.buffer.length,
        processingMode: f.processingMode,
      };
    }),
  );

  const succeeded = uploads.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = uploads.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    // Раньше здесь стоял Promise.all: успевшие объекты оставались в бакете
    // навсегда, потому что запись о них не создавалась.
    log.error({ err: (failed[0] as PromiseRejectedResult).reason }, 's3 putObject failed');
    await scheduleS3Cleanup(db, bundle.id, succeeded.map((a) => a.s3Key), log);
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
      await tx.insert(bundleImportItems).values(
        succeeded.map((a) => ({
          bundleId: bundle.id,
          sourceFilename: a.filename,
          inputS3Key: a.s3Key,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          uploadGeneration: bundle.activeUploadGeneration,
          processingMode: a.processingMode,
          status: 'accepted' as const,
        })),
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

      if (params.dispatch === 'outbox') {
        // Приведение как в domain/mail/resolve-message.ts: тип транзакции
        // drizzle структурно не совпадает с Db, хотя API идентичен.
        await enqueueJob(tx as unknown as Db, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: { bundleId: bundle.id, mode: 'router' },
          dedupeKey: bundleDispatchKeyOf(bundle.id, generation),
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
    await deps.queue.add('parse', { bundleId: bundle.id, mode: 'router' } as never);
  }

  return {
    outcome: 'created',
    bundleId: bundle.id,
    ticket: publicSubmission?.ticket ?? null,
  };
}
