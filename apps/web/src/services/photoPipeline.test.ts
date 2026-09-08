/**
 * Отправка фото с портала идёт через API-прокси (POST /photos/:id/content), а
 * не прямым PUT в S3: у бакета нет CORS-правила для origin портала, поэтому
 * браузерный PUT не проходит preflight и файл до S3 не доезжает.
 *
 * Тест стережёт именно это: что прямого обращения к S3 не осталось, что
 * отдельный /confirm больше не нужен (его делает сам эндпоинт), и что об исходе
 * попытки узнаёт UI — раньше ошибка глохла и пользователь видел «Фото
 * добавлено» на потерянном фото.
 *
 * Локальная база здесь настоящая (fake-indexeddb), а не набор моков: правки
 * про закрытое соединение и удаление полноразмерного blob проверяются только
 * по фактическому содержимому хранилища.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRecord } from '../lib/db';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiUploadPhoto: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { post: mocks.apiPost, delete: mocks.apiDelete },
  apiUploadPhoto: mocks.apiUploadPhoto,
}));

const { uploadPhoto, onPhotoUploadSettled, pruneUploadedPhotoBlobs } = await import(
  './photoPipeline'
);
const { db } = await import('../lib/db');

const LOCAL_ID = 'local-uuid';
const SERVER_ID = 'server-uuid';

function photoRecord(over: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id: LOCAL_ID,
    deliveryId: 'delivery-1',
    operationKind: 'delivery' as const,
    origin: 'local' as const,
    kind: 'cargo' as const,
    stage: 'before' as const,
    contentHash: 'a'.repeat(64),
    idempotencyKey: 'idem-1',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    thumbBlob: new Blob([new Uint8Array([4, 5])], { type: 'image/jpeg' }),
    takenAt: 1_700_000_000_000,
    uploaded: false,
    ...over,
  };
}

async function putPhoto(over: Partial<PhotoRecord> = {}): Promise<void> {
  const dbi = await db();
  await dbi.put('photos', photoRecord(over));
}

async function readPhoto(id: string) {
  const dbi = await db();
  return await dbi.get('photos', id);
}

const presignResponse = {
  photoId: SERVER_ID,
  s3Key: 'site/cp/deliveries/delivery-1/server-uuid.jpg',
  thumbS3Key: 'site/cp/deliveries/delivery-1/server-uuid-thumb.jpg',
  uploadUrl: 'https://s3.cloud.ru/matcheck/…?X-Amz-Signature=deadbeef',
  thumbUploadUrl: 'https://s3.cloud.ru/matcheck/…thumb?X-Amz-Signature=deadbeef',
  expiresIn: 900,
  alreadyExists: false,
};

beforeEach(async () => {
  vi.restoreAllMocks();
  mocks.apiPost.mockReset().mockResolvedValue(presignResponse);
  mocks.apiDelete.mockReset().mockResolvedValue(undefined);
  mocks.apiUploadPhoto.mockReset().mockResolvedValue({ ok: true, uploadedAt: 'now' });
  const dbi = await db();
  await dbi.clear('photos');
  await putPhoto();
});

describe('uploadPhoto — отправка через API-прокси', () => {
  it('шлёт кадр и миниатюру на /photos/:id/content серверным id', async () => {
    await uploadPhoto(LOCAL_ID);

    expect(mocks.apiUploadPhoto).toHaveBeenCalledTimes(1);
    const [path, main, thumb] = mocks.apiUploadPhoto.mock.calls[0]!;
    expect(path).toBe(`/photos/${SERVER_ID}/content`);
    expect(main).toBeInstanceOf(Blob);
    expect(thumb).toBeInstanceOf(Blob);
  });

  it('не ходит в S3 напрямую — иначе снова упрёмся в CORS бакета', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await uploadPhoto(LOCAL_ID);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('не зовёт отдельный /confirm — uploaded_at ставит сам эндпоинт загрузки', async () => {
    await uploadPhoto(LOCAL_ID);
    const posted = mocks.apiPost.mock.calls.map((c) => c[0] as string);
    expect(posted).toEqual(['/photos/presign']);
  });

  it('на успехе меняет локальный id на серверный и помечает uploaded', async () => {
    await uploadPhoto(LOCAL_ID);

    expect(await readPhoto(LOCAL_ID)).toBeUndefined();
    expect(await readPhoto(SERVER_ID)).toMatchObject({
      id: SERVER_ID,
      uploaded: true,
      s3Key: presignResponse.s3Key,
    });
    expect((await readPhoto(SERVER_ID))?.lastUploadError).toBeUndefined();
  });

  it('ошибка отправки доходит до вызывающего и фиксируется в записи', async () => {
    // Раньше провал глох в .catch(() => undefined) внутри capturePhoto, и UI
    // показывал успех на фото, которое осталось только в браузере.
    const failure = Object.assign(new Error('нет сети'), { status: 0, code: 'network' });
    mocks.apiUploadPhoto.mockRejectedValue(failure);

    await expect(uploadPhoto(LOCAL_ID)).rejects.toThrow('нет сети');
    const rec = await readPhoto(LOCAL_ID);
    expect(rec).toMatchObject({ uploaded: false });
    expect(rec?.lastUploadError).toMatchObject({ code: 'network' });
    // Локальная копия — единственная, пока файл не на сервере.
    expect(rec?.blob).toBeInstanceOf(Blob);
  });

  it('сообщает подписчикам об исходе — и на успехе, и на ошибке', async () => {
    // Единственный способ для фонового retryPendingUploads сказать галерее, что
    // кэш ['photos-local', …] устарел: id-swap проходит мимо react-query.
    const seen: Array<[string, string]> = [];
    const off = onPhotoUploadSettled((kind, id) => seen.push([kind, id]));

    await uploadPhoto(LOCAL_ID);
    await putPhoto();
    mocks.apiUploadPhoto.mockRejectedValue(new Error('boom'));
    await expect(uploadPhoto(LOCAL_ID)).rejects.toThrow('boom');
    off();

    expect(seen).toEqual([
      ['delivery', 'delivery-1'],
      ['delivery', 'delivery-1'],
    ]);
  });

  it('уже загруженное фото не трогает сеть', async () => {
    await putPhoto({ uploaded: true });
    await uploadPhoto(LOCAL_ID);
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.apiUploadPhoto).not.toHaveBeenCalled();
  });

  it('после успеха оригинал в браузере не хранится, миниатюра остаётся', async () => {
    // Полноразмерный кадр (1–5 МБ) уже на сервере; вторая копия только
    // приближала эвикт по квоте. Миниатюра нужна галерее приёмки.
    await uploadPhoto(LOCAL_ID);
    const rec = await readPhoto(SERVER_ID);
    expect(rec?.blob).toBeUndefined();
    expect(rec?.thumbBlob).toBeInstanceOf(Blob);
  });

  it('доводит запись до конца, если соединение закрылось на финализации', async () => {
    // Файл уже ушёл на сервер, а запись результата падала на закрытом
    // соединении — фото повисало «незагруженным» при успешной отправке.
    const proto = IDBDatabase.prototype as unknown as {
      transaction: (...args: unknown[]) => unknown;
    };
    const original = proto.transaction;
    let thrown = false;
    proto.transaction = function patched(this: unknown, ...args: unknown[]) {
      if (!thrown && args[1] === 'readwrite') {
        thrown = true;
        throw Object.assign(
          new Error(
            "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
          ),
          { name: 'InvalidStateError' },
        );
      }
      return original.apply(this, args as never);
    } as typeof original;

    try {
      await uploadPhoto(LOCAL_ID);
    } finally {
      proto.transaction = original;
    }

    expect(thrown).toBe(true);
    expect(mocks.apiDelete).not.toHaveBeenCalled();
    expect(await readPhoto(SERVER_ID)).toMatchObject({ uploaded: true });
    expect(await readPhoto(LOCAL_ID)).toBeUndefined();
  });
});

describe('pruneUploadedPhotoBlobs', () => {
  it('освобождает место у подтверждённых и не трогает неотправленные', async () => {
    const dbi = await db();
    await dbi.clear('photos');
    await putPhoto({ id: 'sent', uploaded: true });
    await putPhoto({ id: 'pending', uploaded: false });
    await putPhoto({ id: 'blocked', uploaded: false, uploadState: 'blocked' });

    expect(await pruneUploadedPhotoBlobs()).toBe(1);

    expect((await readPhoto('sent'))?.blob).toBeUndefined();
    expect((await readPhoto('sent'))?.thumbBlob).toBeInstanceOf(Blob);
    // Файл этих двух ещё только в браузере — удаление blob означало бы потерю
    // снимка, а не экономию места.
    expect((await readPhoto('pending'))?.blob).toBeInstanceOf(Blob);
    expect((await readPhoto('blocked'))?.blob).toBeInstanceOf(Blob);
  });

  it('идемпотентна — повторный проход не находит ничего', async () => {
    const dbi = await db();
    await dbi.clear('photos');
    await putPhoto({ id: 'sent', uploaded: true });

    expect(await pruneUploadedPhotoBlobs()).toBe(1);
    expect(await pruneUploadedPhotoBlobs()).toBe(0);
  });
});
