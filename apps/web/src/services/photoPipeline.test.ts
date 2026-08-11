/**
 * Отправка фото с портала идёт через API-прокси (POST /photos/:id/content), а
 * не прямым PUT в S3: у бакета нет CORS-правила для origin портала, поэтому
 * браузерный PUT не проходит preflight и файл до S3 не доезжает.
 *
 * Тест стережёт именно это: что прямого обращения к S3 не осталось, что
 * отдельный /confirm больше не нужен (его делает сам эндпоинт), и что об исходе
 * попытки узнаёт UI — раньше ошибка глохла и пользователь видел «Фото
 * добавлено» на потерянном фото.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  apiUploadPhoto: vi.fn(),
  dbGet: vi.fn(),
  dbPut: vi.fn(),
  dbDelete: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { post: mocks.apiPost, delete: mocks.apiDelete },
  apiUploadPhoto: mocks.apiUploadPhoto,
}));

vi.mock('../lib/db', () => ({
  db: async () => ({ get: mocks.dbGet, put: mocks.dbPut, delete: mocks.dbDelete }),
}));

const { uploadPhoto, onPhotoUploadSettled } = await import('./photoPipeline');

const LOCAL_ID = 'local-uuid';
const SERVER_ID = 'server-uuid';

function photoRecord(over: Record<string, unknown> = {}) {
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

const presignResponse = {
  photoId: SERVER_ID,
  s3Key: 'site/cp/deliveries/delivery-1/server-uuid.jpg',
  thumbS3Key: 'site/cp/deliveries/delivery-1/server-uuid-thumb.jpg',
  uploadUrl: 'https://s3.cloud.ru/matcheck/…?X-Amz-Signature=deadbeef',
  thumbUploadUrl: 'https://s3.cloud.ru/matcheck/…thumb?X-Amz-Signature=deadbeef',
  expiresIn: 900,
  alreadyExists: false,
};

describe('uploadPhoto — отправка через API-прокси', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.apiPost.mockReset().mockResolvedValue(presignResponse);
    mocks.apiDelete.mockReset().mockResolvedValue(undefined);
    mocks.apiUploadPhoto.mockReset().mockResolvedValue({ ok: true, uploadedAt: 'now' });
    mocks.dbGet.mockReset().mockResolvedValue(photoRecord());
    mocks.dbPut.mockReset().mockResolvedValue(undefined);
    mocks.dbDelete.mockReset().mockResolvedValue(undefined);
  });

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

    expect(mocks.dbDelete).toHaveBeenCalledWith('photos', LOCAL_ID);
    expect(mocks.dbPut).toHaveBeenLastCalledWith(
      'photos',
      expect.objectContaining({ id: SERVER_ID, uploaded: true, lastUploadError: undefined }),
    );
  });

  it('ошибка отправки доходит до вызывающего и фиксируется в записи', async () => {
    // Раньше провал глох в .catch(() => undefined) внутри capturePhoto, и UI
    // показывал успех на фото, которое осталось только в браузере.
    const failure = Object.assign(new Error('нет сети'), { status: 0, code: 'network' });
    mocks.apiUploadPhoto.mockRejectedValue(failure);

    await expect(uploadPhoto(LOCAL_ID)).rejects.toThrow('нет сети');
    expect(mocks.dbPut).toHaveBeenLastCalledWith(
      'photos',
      expect.objectContaining({
        uploaded: false,
        lastUploadError: expect.objectContaining({ code: 'network' }),
      }),
    );
  });

  it('сообщает подписчикам об исходе — и на успехе, и на ошибке', async () => {
    // Единственный способ для фонового retryPendingUploads сказать галерее, что
    // кэш ['photos-local', …] устарел: id-swap проходит мимо react-query.
    const seen: Array<[string, string]> = [];
    const off = onPhotoUploadSettled((kind, id) => seen.push([kind, id]));

    await uploadPhoto(LOCAL_ID);
    mocks.apiUploadPhoto.mockRejectedValue(new Error('boom'));
    await expect(uploadPhoto(LOCAL_ID)).rejects.toThrow('boom');
    off();

    expect(seen).toEqual([
      ['delivery', 'delivery-1'],
      ['delivery', 'delivery-1'],
    ]);
  });

  it('уже загруженное фото не трогает сеть', async () => {
    mocks.dbGet.mockResolvedValue(photoRecord({ uploaded: true }));
    await uploadPhoto(LOCAL_ID);
    expect(mocks.apiPost).not.toHaveBeenCalled();
    expect(mocks.apiUploadPhoto).not.toHaveBeenCalled();
  });
});
