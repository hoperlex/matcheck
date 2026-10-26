/**
 * Признаки тождества (`file_id`, `content_key`) для строк реестра, выгруженных
 * до миграции 0139. Новые строки получают их при записи (`storeExportXml`), а
 * старым без них копия из СБИС опознаётся только по совпадению файла.
 *
 * Разово, до включения СБИС (`scripts/edo-identity-backfill.ts`). Читает XML из
 * хранилища и разбирает тем же путём, что и запись (`decodeXmlBuffer` →
 * `parseUpdXml` → `fileIdOf`/`contentKeyOf`). Пишет только эти два поля и
 * только если файл в хранилище — тот самый, что принят в реестр (sha256 совпал
 * с `content_sha256`), и строка не поменялась за время чтения.
 *
 * Повтор безопасен: берутся строки, где оба поля пусты. Строки, у которых
 * признаков нет и в XML (нет номера, даты или позиций, нет ИдФайл), при
 * повторе прочитаются снова — их немного, в отчёте они отдельной строкой.
 */
import { createHash } from 'node:crypto';
import { sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contentKeyOf, fileIdOf } from './export-identity.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { parseUpdXml } from './upd.parser.js';

export type IdentityBackfillDeps = {
  db: Db;
  getObject: (key: string) => Promise<Buffer>;
  /** false — только посчитать, ничего не писать. */
  apply: boolean;
  /** Только строки этой учётки; по умолчанию все. */
  accountId?: string;
  /** Сколько строк за запуск; по умолчанию все. */
  limit?: number;
  /** Сколько файлов читать одновременно. */
  concurrency?: number;
  signal?: AbortSignal;
  /** После каждой пачки строк — ход работы (итог печатается только в конце). */
  onProgress?: (report: IdentityBackfillReport) => void;
};

export type IdentityBackfillFailure = { id: string; reason: string };

export type IdentityBackfillReport = {
  /** Строк без признаков, взятых в работу. */
  scanned: number;
  /** Получили хотя бы один признак (при dry-run — получили бы). */
  filled: number;
  withFileId: number;
  withContentKey: number;
  /** XML разобран, но признаков в нём нет. */
  noKeys: number;
  /** Строка изменилась за время чтения — не тронута. */
  changed: number;
  failures: IdentityBackfillFailure[];
  /** Остановлено сигналом до конца выборки. */
  stopped: boolean;
};

const BATCH = 200;

type Candidate = { id: string; s3_key: string; content_sha256: string | null };

export async function backfillExportIdentity(deps: IdentityBackfillDeps): Promise<IdentityBackfillReport> {
  const report: IdentityBackfillReport = {
    scanned: 0,
    filled: 0,
    withFileId: 0,
    withContentKey: 0,
    noKeys: 0,
    changed: 0,
    failures: [],
    stopped: false,
  };
  const limit = deps.limit ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, deps.concurrency ?? 4);
  // Постранично по id: каждая строка — один раз за запуск, даже если
  // признаков в ней не нашлось и она осталась под условием выборки.
  let afterId = '00000000-0000-0000-0000-000000000000';

  const one = async (row: Candidate): Promise<void> => {
    let buffer: Buffer;
    try {
      buffer = await deps.getObject(row.s3_key);
    } catch (err) {
      report.failures.push({ id: row.id, reason: `хранилище: ${errorText(err)}` });
      return;
    }
    const sha = createHash('sha256').update(buffer).digest('hex');
    if (row.content_sha256 && sha !== row.content_sha256) {
      report.failures.push({ id: row.id, reason: 'файл в хранилище не совпадает с принятым (sha256)' });
      return;
    }
    let fileId: string | null;
    let contentKey: string | null;
    try {
      const parsed = parseUpdXml(decodeXmlBuffer(buffer));
      fileId = fileIdOf(parsed);
      contentKey = contentKeyOf(parsed);
    } catch (err) {
      report.failures.push({ id: row.id, reason: `разбор: ${errorText(err)}` });
      return;
    }
    if (!fileId && !contentKey) {
      report.noKeys += 1;
      return;
    }
    if (deps.apply) {
      // Условие — в самом UPDATE: строку могли перезаписать (повтор сбоя,
      // проход выгрузки) между выборкой и записью.
      const updated = await deps.db.execute<{ id: string }>(drSql`
        update edo_export_documents
           set file_id = coalesce(file_id, ${fileId}),
               content_key = coalesce(content_key, ${contentKey})
         where id = ${row.id} and status = 'stored' and s3_key = ${row.s3_key}
           and content_sha256 is not distinct from ${row.content_sha256}
           and file_id is null and content_key is null
        returning id`);
      if (!updated.length) {
        report.changed += 1;
        return;
      }
    }
    report.filled += 1;
    if (fileId) report.withFileId += 1;
    if (contentKey) report.withContentKey += 1;
  };

  while (report.scanned < limit) {
    if (deps.signal?.aborted) {
      report.stopped = true;
      break;
    }
    const take = Math.min(BATCH, limit - report.scanned);
    const rows = await deps.db.execute<Candidate>(drSql`
      select id, s3_key, content_sha256 from edo_export_documents
       where status = 'stored' and s3_key is not null
         and file_id is null and content_key is null
         and (${deps.accountId ?? null}::uuid is null or edo_account_id = ${deps.accountId ?? null}::uuid)
         and id > ${afterId}::uuid
       order by id
       limit ${take}`);
    if (!rows.length) break;
    afterId = rows[rows.length - 1]!.id;
    report.scanned += rows.length;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(rows.slice(i, i + concurrency).map(one));
    }
    deps.onProgress?.(report);
  }
  return report;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
