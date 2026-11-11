/**
 * Замер прохода поиска изменений для очереди 1С на боевом объёме — ТОЛЬКО
 * чтение (один снимок REPEATABLE READ READ ONLY), ничего не пишет.
 *
 * Проход пересчитывает хеш выгруженных приёмок в окне (domain/onec/detection.ts)
 * тем же построителем, что отдаёт данные. До включения канала выгруженных нет,
 * поэтому меряем на последних подтверждённых приёмках — столько, сколько
 * окажется в окне (по умолчанию 4000 ≈ 30 дней).
 *
 *   --last 4000      сколько последних подтверждённых МОЛ приёмок взять
 *
 * Порог включения (план): проход быстрее 5 с. Медленнее — не включать, а
 * вынести проход в фоновую задачу отдельным планом.
 *
 * Запуск на бою:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T matcheck-api \
 *     node_modules/.bin/tsx scripts/onec-detect-bench.ts --last 4000
 */
import { parseArgs } from 'node:util';
import { sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { DETECTION_BATCH } from '../src/domain/onec/detection.js';
import { readInSnapshot } from '../src/domain/onec/export-loader.js';
import { buildBodies } from '../src/domain/onec/export-read.js';
import { errorChain } from '../src/lib/error-chain.js';

const THRESHOLD_MS = 5000;

const { values: args } = parseArgs({
  options: { last: { type: 'string', default: '4000' } },
});

async function main(): Promise<number> {
  const last = Number.parseInt(args.last ?? '4000', 10);
  if (!Number.isInteger(last) || last <= 0 || last > 50_000) {
    console.error('--last: целое от 1 до 50000');
    return 1;
  }
  const started = Date.now();
  const stats = await readInSnapshot(db, async (tx, snapshotAt) => {
    const ids = [
      ...(await tx.execute(drSql`
        select d.id::text as id
          from deliveries d
          join statuses s on s.id = d.status_id and s.entity_type = 'delivery' and s.code = 'confirmed_mol'
         where d.pending_deletion_at is null and d.confirmed_by_mol_at is not null
         order by d.confirmed_by_mol_at desc
         limit ${last}`)),
    ].map((r) => (r as { id: string }).id);
    let built = 0;
    let lines = 0;
    let maxLines = 0;
    let maxBatchMs = 0;
    for (let i = 0; i < ids.length; i += DETECTION_BATCH) {
      const t = Date.now();
      const bodies = await buildBodies(tx, ids.slice(i, i + DETECTION_BATCH), snapshotAt);
      maxBatchMs = Math.max(maxBatchMs, Date.now() - t);
      for (const { body } of bodies.values()) {
        built += 1;
        const n = body.groups.reduce((acc, g) => acc + g.lines.length, 0);
        lines += n;
        maxLines = Math.max(maxLines, n);
      }
    }
    return { requested: ids.length, built, lines, maxLines, maxBatchMs };
  });
  const ms = Date.now() - started;
  console.info(
    `приёмок: ${stats.built} из ${stats.requested}; строк: ${stats.lines} (макс. в приёмке ${stats.maxLines})`,
  );
  console.info(
    `проход: ${ms} мс; порция ${DETECTION_BATCH} — до ${stats.maxBatchMs} мс; ` +
      `на 100 приёмок ≈ ${stats.built ? Math.round((ms * 100) / stats.built) : 0} мс`,
  );
  console.info(ms < THRESHOLD_MS ? `ниже порога ${THRESHOLD_MS} мс — можно включать` : `ВЫШЕ порога ${THRESHOLD_MS} мс — не включать`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(errorChain(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
