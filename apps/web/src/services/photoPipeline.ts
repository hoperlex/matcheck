import type {
  DeliveryPhotoStage,
  PhotoConfirmResponse,
  PhotoPresignResponse,
} from '@matcheck/contracts';
import { api, apiUploadPhoto } from './api';
import { db, type OperationKind } from '../lib/db';
import { backoffMs, classifyUploadError, toErrorInfo } from './uploadRetryPolicy';

/**
 * Подписчики на завершение отправки фото. Нужны из-за фонового цикла:
 * retryPendingUploads зовётся из runSync, и при успехе локальный id меняется на
 * серверный — а React Query-кэш ['photos-local', ...] об этом не узнаёт и
 * показывает и серверное фото, и осиротевшую локальную копию под старым id.
 * Экраны подписываются и инвалидируют свой ключ.
 */
type PhotoSettledListener = (operationKind: OperationKind, operationId: string) => void;
const photoSettledListeners = new Set<PhotoSettledListener>();

export function onPhotoUploadSettled(listener: PhotoSettledListener): () => void {
  photoSettledListeners.add(listener);
  return () => photoSettledListeners.delete(listener);
}

function notifyPhotoSettled(operationKind: OperationKind, operationId: string): void {
  for (const listener of photoSettledListeners) {
    try {
      listener(operationKind, operationId);
    } catch {
      // Подписчик не должен ломать цикл отправки.
    }
  }
}

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = Promise.resolve(
      new Worker(new URL('../workers/imageCompress.worker.ts', import.meta.url), {
        type: 'module',
      }),
    );
  }
  return workerPromise;
}

let nextId = 1;
async function compressInWorker(
  blob: Blob,
  maxSizeMB: number,
  maxWidthOrHeight: number,
): Promise<Blob> {
  const worker = await getWorker();
  const id = nextId++;
  return new Promise<Blob>((resolve, reject) => {
    const onMessage = (evt: MessageEvent) => {
      const data = evt.data as { id: number; ok: boolean; blob?: Blob; error?: string };
      if (data.id !== id) return;
      worker.removeEventListener('message', onMessage);
      if (data.ok && data.blob) resolve(data.blob);
      else reject(new Error(data.error ?? 'compress failed'));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, blob, maxSizeMB, maxWidthOrHeight });
  });
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type CapturedPhoto = {
  /**
   * Локальный uuid сразу после захвата. Используется как ключ в IDB до тех
   * пор, пока uploadPromise не подменит его на server-id из presign-ответа.
   */
  id: string;
  /**
   * Итог отправки. Резолвится ПОСЛЕ того, как IDB-запись переименована на
   * server-id: вызывающий код подписывается для повторного invalidate
   * queryClient, иначе UI продолжит читать запись по old-id, которой в IDB
   * уже нет.
   *
   * Возвращаем `{ ok, error }`, а не отклонённый promise: раньше здесь стоял
   * `.catch(() => undefined)`, и вызывающий физически не мог узнать о сбое —
   * фото молча оставалось локальным, а пользователь видел «Фото добавлено».
   * Результатом вместо reject снимаем и риск unhandled rejection у тех, кто
   * промис не ждёт.
   */
  uploadPromise: Promise<PhotoUploadOutcome>;
};

export type PhotoUploadOutcome = { ok: true } | { ok: false; error: unknown };

function settle(promise: Promise<void>): Promise<PhotoUploadOutcome> {
  return promise.then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
}

export async function capturePhoto(
  operationKind: OperationKind,
  operationId: string,
  blob: Blob,
  kind: 'document' | 'cargo' | 'vehicle' | 'other',
  stage: DeliveryPhotoStage = 'before',
): Promise<CapturedPhoto> {
  const main = await compressInWorker(blob, 1.5, 2048);
  const thumb = await compressInWorker(blob, 0.1, 320);
  const contentHash = await sha256Hex(main);
  const id = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const dbi = await db();

  // De-dup locally если такой же hash уже есть для этой операции
  // (поле deliveryId хранит operationId — для приёмки и отгрузки).
  const existing = await dbi
    .transaction('photos')
    .objectStore('photos')
    .index('byHash')
    .get(contentHash);
  if (existing && existing.deliveryId === operationId && existing.operationKind === operationKind) {
    // Уже есть локальная запись с этим contentHash. Если она ещё не uploaded —
    // переиспользуем её promise upload'а, а не плодим параллельные попытки.
    const uploadPromise = existing.uploaded
      ? Promise.resolve({ ok: true } as const)
      : settle(uploadPhoto(existing.id));
    return { id: existing.id, uploadPromise };
  }

  await dbi.put('photos', {
    id,
    deliveryId: operationId,
    operationKind,
    origin: 'local',
    kind,
    stage,
    contentHash,
    idempotencyKey,
    blob: main,
    thumbBlob: thumb,
    takenAt: Date.now(),
    uploaded: false,
  });

  // Best-effort immediate upload — выставляем результат наружу, чтобы UI мог
  // дождаться обмена local-id на server-id, пере-invalidate queryClient и
  // показать ошибку, если отправка не удалась.
  const uploadPromise = settle(uploadPhoto(id));
  return { id, uploadPromise };
}

export async function uploadPhoto(photoId: string): Promise<void> {
  const dbi = await db();
  const p = await dbi.get('photos', photoId);
  if (!p || p.uploaded || !p.blob) return;

  // Любой исход попытки меняет то, что должна показать галерея: успех — id-swap
  // и снятие «загружается», провал — новый lastUploadError. Поэтому сигналим и
  // там, и там; фоновому циклу retryPendingUploads это единственный способ
  // сообщить UI, что кэш ['photos-local', ...] устарел.
  try {
    const presign = await api.post<PhotoPresignResponse>('/photos/presign', {
      operationKind: p.operationKind,
      operationId: p.deliveryId,
      // deliveryId оставляем для совместимости со старым сервером (≤ Phase 1).
      deliveryId: p.operationKind === 'delivery' ? p.deliveryId : undefined,
      kind: p.kind,
      contentHash: p.contentHash,
      idempotencyKey: p.idempotencyKey,
      contentType: 'image/jpeg',
      thumbContentHash: p.thumbBlob ? await sha256Hex(p.thumbBlob) : undefined,
      // Этап актуален только для приёмок; для отгрузок сервер поле игнорирует.
      stage: p.operationKind === 'delivery' ? p.stage : undefined,
    });

    // Байты уходят на НАШ домен, а в S3 их кладёт сервер. Прямой PUT по
    // presign.uploadUrl из браузера не проходит preflight — у бакета нет
    // CORS-правила для origin портала, и файл до S3 не доезжал вовсе, оставляя
    // orphan-строку, которую через час сносил cleanup-job. Поле uploadUrl из
    // ответа presign веб намеренно не использует; мобильный клиент — использует.
    //
    // Отдельный /confirm не нужен: этот эндпоинт сам проставляет uploaded_at и
    // возвращает тот же контракт. Идемпотентность на стороне сервера — на уже
    // подтверждённом фото он не трогает S3.
    await apiUploadPhoto<PhotoConfirmResponse>(
      `/photos/${presign.photoId}/content`,
      p.blob,
      p.thumbBlob,
    );

    // Пользователь мог удалить фото, пока шёл upload (presign/PUT/confirm). Если
    // исходной IDB-записи уже нет — НЕ воскрешаем её put'ом ниже, а подчищаем
    // созданную на сервере строку, иначе появится «мёртвый» orphan или воскресшее
    // confirmed-фото. Проверяем именно по исходному p.id (id-swap делает этот же вызов).
    const still = await dbi.get('photos', p.id);
    if (!still) {
      await api.delete(`/photos/${presign.photoId}`).catch(() => undefined);
      return;
    }

    // Сервер генерирует photoId сам (см. apps/api/routes/photos.ts: insert с
    // crypto.randomUUID()). Чтобы merged-список в UI не показывал ДВА фото
    // (server + local с разными id), синхронизируем локальный id с серверным —
    // тот же приём, что в matcheck.mobile PhotoUploadProcessor.kt.
    if (presign.photoId !== p.id) {
      await dbi.delete('photos', p.id);
    }
    await dbi.put('photos', {
      ...p,
      id: presign.photoId,
      s3Key: presign.s3Key,
      thumbS3Key: presign.thumbS3Key ?? undefined,
      uploaded: true,
      // Успех — сбрасываем накопленное состояние ретраев.
      uploadState: undefined,
      uploadAttempts: undefined,
      nextRetryAt: undefined,
      lastUploadError: undefined,
    });
  } catch (err) {
    await recordUploadFailure(dbi, p.id, err);
    throw err;
  } finally {
    notifyPhotoSettled(p.operationKind, p.deliveryId);
  }
}

/**
 * Фиксирует неудачу отправки в IDB БЕЗ удаления blob. Терминальные ошибки
 * (приёмка удалена/forbidden) → `blocked`; ретраибельные (not_in_s3, сеть, 5xx)
 * → capped backoff. Локальная копия фото сохраняется всегда — она может быть
 * единственной.
 */
async function recordUploadFailure(
  dbi: Awaited<ReturnType<typeof db>>,
  id: string,
  err: unknown,
): Promise<void> {
  const cur = await dbi.get('photos', id);
  if (!cur || cur.uploaded) return; // запись удалена или уже залита — фиксировать нечего
  const info = toErrorInfo(err);
  const cls = classifyUploadError(info);
  const attempts = (cur.uploadAttempts ?? 0) + 1;
  const lastUploadError = {
    status: info.status,
    code: info.code ?? (info.network ? 'network' : 'unknown'),
    at: Date.now(),
  };
  if (cls === 'terminal') {
    await dbi.put('photos', {
      ...cur,
      uploadState: 'blocked',
      uploadAttempts: attempts,
      lastUploadError,
    });
  } else {
    await dbi.put('photos', {
      ...cur,
      uploadAttempts: attempts,
      nextRetryAt: Date.now() + backoffMs(attempts, cls),
      lastUploadError,
    });
  }
}

/**
 * Сериализует retryPendingUploads МЕЖДУ вкладками. Без этого каждая открытая
 * вкладка гоняет свой цикл раз в минуту и параллельно шлёт presign одного и
 * того же фото (RUNNING в sync.ts защищает лишь свою вкладку). Web Lock —
 * exclusive на весь origin; вторая вкладка ждёт, а после захвата перечитывает
 * IDB (первая уже могла залить/пометить записи). Fallback без Web Locks
 * сохраняет single-flight хотя бы внутри вкладки через sync.ts.
 */
async function withPhotoRetryLock(fn: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    await navigator.locks.request('matcheck-photo-retry', { mode: 'exclusive' }, fn);
  } else {
    await fn();
  }
}

export async function retryPendingUploads(): Promise<void> {
  await withPhotoRetryLock(async () => {
    const dbi = await db();
    // getAll ВНУТРИ лока: к моменту захвата другая вкладка могла изменить записи.
    const all = await dbi.getAll('photos');
    const now = Date.now();
    for (const p of all) {
      if (p.uploaded) continue;
      if (p.uploadState === 'blocked') continue; // терминальная ошибка — не долбим
      if (p.nextRetryAt && p.nextRetryAt > now) continue; // backoff ещё не истёк
      // Операция должна быть уже на сервере, иначе /photos/presign даст 404.
      // Ждём следующего прохода runSync после успешного push *_upsert.
      if (p.operationKind === 'shipment') {
        const sh = await dbi.get('shipments', p.deliveryId);
        if (!sh || sh.server === null) continue;
      } else {
        const dlv = await dbi.get('deliveries', p.deliveryId);
        if (!dlv || dlv.server === null) continue;
      }
      try {
        await uploadPhoto(p.id);
      } catch {
        // Состояние (backoff/blocked) уже записано в uploadPhoto → recordUploadFailure.
      }
    }
  });
}
