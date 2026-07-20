import { describe, it, expect, vi } from 'vitest';
import { buildExistingPhotoPresign } from '../src/domain/photos/presign-existing.js';

const TTL = 900;

describe('buildExistingPhotoPresign', () => {
  it('uploaded_at != null → alreadyExists, пустые URL, presign НЕ вызывается', async () => {
    const presign = vi.fn();
    const res = await buildExistingPhotoPresign(
      {
        id: 'p1',
        s3Key: 'key/main.jpg',
        thumbS3Key: 'key/thumb.jpg',
        uploadedAt: new Date('2026-07-20T08:00:00Z'),
      },
      TTL,
      presign,
    );

    expect(res.alreadyExists).toBe(true);
    expect(res.uploadUrl).toBe('');
    expect(res.thumbUploadUrl).toBeNull();
    expect(res.photoId).toBe('p1');
    expect(res.s3Key).toBe('key/main.jpg');
    expect(res.thumbS3Key).toBe('key/thumb.jpg');
    // уже в S3 — повторно подписывать нечего
    expect(presign).not.toHaveBeenCalled();
  });

  it('orphan с thumbS3Key → alreadyExists=false, оба URL из presign', async () => {
    const presign = vi.fn(async () => ({
      uploadUrl: 'https://s3/put-main',
      thumbUploadUrl: 'https://s3/put-thumb',
    }));
    const res = await buildExistingPhotoPresign(
      { id: 'p2', s3Key: 'key/main.jpg', thumbS3Key: 'key/thumb.jpg', uploadedAt: null },
      TTL,
      presign,
    );

    expect(res.alreadyExists).toBe(false);
    expect(res.uploadUrl).toBe('https://s3/put-main');
    expect(res.thumbUploadUrl).toBe('https://s3/put-thumb');
    expect(presign).toHaveBeenCalledWith('key/main.jpg', 'key/thumb.jpg');
  });

  it('orphan без thumbS3Key → thumbUploadUrl остаётся null', async () => {
    const presign = vi.fn(async () => ({ uploadUrl: 'https://s3/put-main', thumbUploadUrl: null }));
    const res = await buildExistingPhotoPresign(
      { id: 'p3', s3Key: 'key/main.jpg', thumbS3Key: null, uploadedAt: null },
      TTL,
      presign,
    );

    expect(res.alreadyExists).toBe(false);
    expect(res.uploadUrl).toBe('https://s3/put-main');
    expect(res.thumbUploadUrl).toBeNull();
    expect(presign).toHaveBeenCalledWith('key/main.jpg', null);
  });
});
