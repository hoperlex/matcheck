import type { PhotoPresignResponse } from '@matcheck/contracts';

/** Строка delivery_photos / shipment_photos в объёме, нужном для решения presign. */
export type ExistingPhotoRow = {
  id: string;
  s3Key: string;
  thumbS3Key: string | null;
  uploadedAt: Date | null;
};

/**
 * Формирует ответ presign для УЖЕ существующей (по contentHash) строки фото.
 *
 * Развилка по uploaded_at — иначе повторный presign после незавершённого PUT
 * зацикливает клиента (presign→confirm(404 not_in_s3)→presign…):
 *  - uploaded_at != null — файл реально в S3, PUT не нужен: alreadyExists=true,
 *    URL пустые;
 *  - uploaded_at == null — orphan (предыдущий PUT не дошёл): alreadyExists=false
 *    и свежие URL (включая thumb, если у строки есть thumbS3Key), чтобы клиент
 *    перезалил и confirm нашёл объект.
 *
 * presignReupload вызывается ТОЛЬКО для orphan — лишнего S3-подписания для уже
 * загруженного фото не происходит.
 */
export async function buildExistingPhotoPresign(
  existing: ExistingPhotoRow,
  expiresIn: number,
  presignReupload: (
    s3Key: string,
    thumbS3Key: string | null,
  ) => Promise<{ uploadUrl: string; thumbUploadUrl: string | null }>,
): Promise<PhotoPresignResponse> {
  if (existing.uploadedAt) {
    return {
      photoId: existing.id,
      s3Key: existing.s3Key,
      thumbS3Key: existing.thumbS3Key,
      uploadUrl: '',
      thumbUploadUrl: null,
      expiresIn,
      alreadyExists: true,
    };
  }
  const { uploadUrl, thumbUploadUrl } = await presignReupload(existing.s3Key, existing.thumbS3Key);
  return {
    photoId: existing.id,
    s3Key: existing.s3Key,
    thumbS3Key: existing.thumbS3Key,
    uploadUrl,
    thumbUploadUrl,
    expiresIn,
    alreadyExists: false,
  };
}
