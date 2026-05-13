import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  PhotoGetUrlResponseSchema,
  PhotoPresignRequestSchema,
  PhotoPresignResponseSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { deliveries, deliveryPhotos } from '../db/schema.js';
import { presign } from '../domain/storage/s3.signer.js';
import { publishEvent } from './events.js';

const URL_TTL = 300; // 5 min

export async function photoRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.post(
    '/api/v1/photos/presign',
    {
      preHandler: [app.authenticate],
      schema: {
        body: PhotoPresignRequestSchema,
        response: {
          200: PhotoPresignResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { deliveryId, kind, contentHash, idempotencyKey, contentType, thumbContentHash } =
        req.body;
      const [d] = await app.db
        .select({ id: deliveries.id, inspectorId: deliveries.inspectorId })
        .from(deliveries)
        .where(eq(deliveries.id, deliveryId))
        .limit(1);
      if (!d) return reply.code(404).send({ error: 'delivery_not_found' });
      if (req.user?.role === 'inspector_kpp' && d.inspectorId !== req.user.id) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const [existing] = await app.db
        .select()
        .from(deliveryPhotos)
        .where(
          and(
            eq(deliveryPhotos.deliveryId, deliveryId),
            eq(deliveryPhotos.contentHash, contentHash),
          ),
        )
        .limit(1);
      if (existing) {
        const uploadUrl = await presign({
          method: 'PUT',
          key: existing.s3Key,
          expiresIn: URL_TTL,
          contentType,
        }).catch(() => '');
        return {
          photoId: existing.id,
          s3Key: existing.s3Key,
          thumbS3Key: existing.thumbS3Key,
          uploadUrl: uploadUrl || '',
          thumbUploadUrl: null,
          expiresIn: URL_TTL,
          alreadyExists: true,
        };
      }

      const photoId = crypto.randomUUID();
      const s3Key = `photos/${deliveryId}/${photoId}.jpg`;
      const thumbS3Key = thumbContentHash ? `photos/${deliveryId}/${photoId}-thumb.jpg` : null;
      const [created] = await app.db
        .insert(deliveryPhotos)
        .values({
          id: photoId,
          deliveryId,
          kind,
          s3Key,
          thumbS3Key,
          contentHash,
          idempotencyKey,
        })
        .returning();
      if (!created) throw new Error('Failed to insert photo');

      let uploadUrl = '';
      let thumbUploadUrl: string | null = null;
      try {
        uploadUrl = await presign({ method: 'PUT', key: s3Key, expiresIn: URL_TTL, contentType });
        if (thumbS3Key) {
          thumbUploadUrl = await presign({
            method: 'PUT',
            key: thumbS3Key,
            expiresIn: URL_TTL,
            contentType,
          });
        }
      } catch (err) {
        app.log.warn({ err }, 'presign failed — returning empty URLs');
      }

      publishEvent(app, { type: 'delivery_updated', id: deliveryId, ts: new Date().toISOString() });

      return {
        photoId,
        s3Key,
        thumbS3Key,
        uploadUrl,
        thumbUploadUrl,
        expiresIn: URL_TTL,
        alreadyExists: false,
      };
    },
  );

  app.get(
    '/api/v1/photos/:id/url',
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ thumb: z.coerce.boolean().default(false) }),
        response: {
          200: PhotoGetUrlResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const [p] = await app.db
        .select({
          s3Key: deliveryPhotos.s3Key,
          thumbS3Key: deliveryPhotos.thumbS3Key,
          deliveryId: deliveryPhotos.deliveryId,
        })
        .from(deliveryPhotos)
        .where(eq(deliveryPhotos.id, req.params.id))
        .limit(1);
      if (!p) return reply.code(404).send({ error: 'not_found' });
      const key = req.query.thumb && p.thumbS3Key ? p.thumbS3Key : p.s3Key;
      try {
        const url = await presign({ method: 'GET', key, expiresIn: URL_TTL });
        return { url, expiresIn: URL_TTL };
      } catch {
        return reply.code(500).send({ error: 's3_unavailable', message: 'S3 not configured' });
      }
    },
  );
}
