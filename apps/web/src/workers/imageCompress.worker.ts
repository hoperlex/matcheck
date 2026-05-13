/// <reference lib="WebWorker" />
import imageCompression from 'browser-image-compression';

export type CompressRequest = {
  id: number;
  blob: Blob;
  maxSizeMB: number;
  maxWidthOrHeight: number;
};

export type CompressResponse =
  | { id: number; ok: true; blob: Blob }
  | { id: number; ok: false; error: string };

self.addEventListener('message', async (evt: MessageEvent<CompressRequest>) => {
  const { id, blob, maxSizeMB, maxWidthOrHeight } = evt.data;
  try {
    const file = new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' });
    const out = await imageCompression(file, {
      maxSizeMB,
      maxWidthOrHeight,
      useWebWorker: false,
      fileType: 'image/jpeg',
      initialQuality: 0.8,
    });
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
      id,
      ok: true,
      blob: out,
    } satisfies CompressResponse);
  } catch (err: unknown) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies CompressResponse);
  }
});
