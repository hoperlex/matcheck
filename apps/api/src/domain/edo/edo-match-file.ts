/**
 * Файл УПД из ЭДО, привязанной к приёмке: где лежит, как называется, сколько
 * весит. Общий для карточки приёмки (presign в routes/delivery-edo.ts) и
 * машинного канала 1С (сырые байты в domain/onec/edo-xml.ts) — чтобы оба
 * открывали один и тот же файл по одним правилам.
 *
 * Две ветки привязки:
 *  - export_document_id → строка реестра ЭДО (Диадок/СБИС), только stored;
 *  - source_document_id → импортированная карточка Диадока, вложение original.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  deliveryEdoMatches,
  edoExportDocuments,
  sourceDocumentAttachments,
} from '../../db/schema.js';

export type EdoMatchFile = {
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  /** sha256 из реестра (только для export-ветки). */
  sha256: string | null;
};

export type EdoMatchFileResult =
  | { kind: 'ok'; file: EdoMatchFile }
  | { kind: 'not_found' }
  | { kind: 'file_not_found' };

export async function resolveEdoMatchFile(
  db: Db,
  deliveryId: string,
  matchId: string,
): Promise<EdoMatchFileResult> {
  const [match] = await db
    .select({
      sourceDocumentId: deliveryEdoMatches.sourceDocumentId,
      exportDocumentId: deliveryEdoMatches.exportDocumentId,
    })
    .from(deliveryEdoMatches)
    .where(and(eq(deliveryEdoMatches.id, matchId), eq(deliveryEdoMatches.deliveryId, deliveryId)))
    .limit(1);
  if (!match) return { kind: 'not_found' };

  if (match.exportDocumentId) {
    const [record] = await db
      .select({
        s3Key: edoExportDocuments.s3Key,
        sizeBytes: edoExportDocuments.sizeBytes,
        sha256: edoExportDocuments.contentSha256,
      })
      .from(edoExportDocuments)
      .where(
        and(
          eq(edoExportDocuments.id, match.exportDocumentId),
          eq(edoExportDocuments.status, 'stored'),
        ),
      )
      .limit(1);
    if (!record?.s3Key) return { kind: 'file_not_found' };
    return {
      kind: 'ok',
      file: {
        s3Key: record.s3Key,
        filename: record.s3Key.split('/').pop() ?? 'УПД.xml',
        mimeType: 'application/xml',
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
      },
    };
  }
  if (match.sourceDocumentId) {
    const [attachment] = await db
      .select({
        s3Key: sourceDocumentAttachments.s3Key,
        filename: sourceDocumentAttachments.filename,
        mimeType: sourceDocumentAttachments.mimeType,
        sizeBytes: sourceDocumentAttachments.sizeBytes,
      })
      .from(sourceDocumentAttachments)
      .where(
        and(
          eq(sourceDocumentAttachments.sourceDocumentId, match.sourceDocumentId),
          eq(sourceDocumentAttachments.role, 'original'),
        ),
      )
      .orderBy(desc(sourceDocumentAttachments.createdAt))
      .limit(1);
    if (!attachment) return { kind: 'file_not_found' };
    return {
      kind: 'ok',
      file: {
        s3Key: attachment.s3Key,
        filename: attachment.filename,
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        sizeBytes: attachment.sizeBytes,
        sha256: null,
      },
    };
  }
  return { kind: 'file_not_found' };
}
