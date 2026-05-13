import { z } from 'zod';

export const PhotoKindSchema = z.enum(['document', 'cargo', 'vehicle', 'other']);

export const PhotoPresignRequestSchema = z.object({
  deliveryId: z.string().uuid(),
  kind: PhotoKindSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().uuid(),
  contentType: z.string().default('image/jpeg'),
  thumbContentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type PhotoPresignRequest = z.infer<typeof PhotoPresignRequestSchema>;

export const PhotoPresignResponseSchema = z.object({
  photoId: z.string().uuid(),
  s3Key: z.string(),
  thumbS3Key: z.string().nullable(),
  uploadUrl: z.string(),
  thumbUploadUrl: z.string().nullable(),
  expiresIn: z.number(),
  alreadyExists: z.boolean(),
});
export type PhotoPresignResponse = z.infer<typeof PhotoPresignResponseSchema>;

export const PhotoGetUrlResponseSchema = z.object({
  url: z.string(),
  expiresIn: z.number(),
});
