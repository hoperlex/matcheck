import type {
  DeliveryPhotoStage,
  PhotoConfirmResponse,
  PhotoPresignResponse,
} from '@matcheck/contracts';
import { api } from './api';
import { db, type OperationKind } from '../lib/db';

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
   * Promise успешного завершения S3-upload + /confirm. Резолвится после того,
   * как IDB-запись переименована на server-id. Вызывающий код подписывается
   * через .then(...) для повторного invalidate queryClient — без этого UI
   * продолжит читать запись по old-id, которой в IDB уже нет.
   */
  uploadPromise: Promise<void>;
};

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
      ? Promise.resolve()
      : uploadPhoto(existing.id).catch(() => undefined);
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

  // Best-effort immediate upload — выставляем promise наружу, чтобы UI мог
  // дождаться обмена local-id на server-id и пере-invalidate queryClient.
  const uploadPromise = uploadPhoto(id).catch(() => undefined);
  return { id, uploadPromise };
}

export async function uploadPhoto(photoId: string): Promise<void> {
  const dbi = await db();
  const p = await dbi.get('photos', photoId);
  if (!p || p.uploaded || !p.blob) return;

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

  if (!presign.alreadyExists && presign.uploadUrl) {
    const r = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: p.blob,
    });
    if (!r.ok) throw new Error(`S3 upload failed: ${r.status}`);
    if (presign.thumbUploadUrl && p.thumbBlob) {
      await fetch(presign.thumbUploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: p.thumbBlob,
      }).catch(() => undefined);
    }
  }

  // Confirm обязателен: сервер делает HEAD в S3 и проставляет uploaded_at.
  // Без него запись остаётся orphan'ом (uploaded_at=null) и через час будет
  // вычищена cleanup-job'ом — фото пропадёт. См. apps/api/routes/photos.ts.
  await api.post<PhotoConfirmResponse>(`/photos/${presign.photoId}/confirm`, {});

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
  });
}

export async function retryPendingUploads(): Promise<void> {
  const dbi = await db();
  const all = await dbi.getAll('photos');
  for (const p of all) {
    if (p.uploaded) continue;
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
      /* ignore */
    }
  }
}
