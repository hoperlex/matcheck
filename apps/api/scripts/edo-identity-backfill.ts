/**
 * Признаки тождества (`file_id`, `content_key`) для строк реестра УПД,
 * выгруженных до миграции 0139 — разово, до включения СБИС. Логика —
 * src/domain/edo/identity-backfill.ts.
 *
 * Без --apply только считает: сколько строк получили бы признаки, сколько без
 * них и какие не прочитались. С --apply пишет эти два поля и больше ничего.
 *
 *   --apply            записать (по умолчанию — пробный подсчёт)
 *   --account <uuid>   только строки этой учётки (по умолчанию все)
 *   --limit N          не больше N строк за запуск (по умолчанию все)
 *   --concurrency N    одновременных чтений из хранилища (по умолчанию 4)
 *
 * Коды выхода: 0 — без сбоев; 1 — были сбои чтения или разбора (повторный
 * запуск возьмёт их снова) либо запуск прерван.
 *
 * Запуск на бою:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T matcheck-api \
 *     node_modules/.bin/tsx scripts/edo-identity-backfill.ts            # подсчёт
 *   … scripts/edo-identity-backfill.ts --apply                          # запись
 */
import { parseArgs } from 'node:util';
import { db, sql } from '../src/db/client.js';
import { errorChain } from '../src/lib/error-chain.js';
import { backfillExportIdentity } from '../src/domain/edo/identity-backfill.js';
import { getObject } from '../src/domain/storage/s3.signer.js';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    account: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
  },
});

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name}: ожидается целое больше нуля`);
  return n;
}

/** Ход в stderr не чаще, чем раз в столько строк: 11 тыс. чтений идут ~20 минут. */
const PROGRESS_EVERY = 500;

async function main(): Promise<number> {
  const controller = new AbortController();
  let printedAt = 0;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
  const report = await backfillExportIdentity({
    db,
    getObject,
    apply: args.apply === true,
    accountId: args.account,
    limit: positiveInt('limit', args.limit),
    concurrency: positiveInt('concurrency', args.concurrency),
    signal: controller.signal,
    onProgress: (r) => {
      if (r.scanned - printedAt < PROGRESS_EVERY) return;
      printedAt = r.scanned;
      console.error(`… взято ${r.scanned}, признаки у ${r.filled}, без признаков ${r.noKeys}, сбоев ${r.failures.length}`);
    },
  });
  const verb = args.apply ? 'записано' : 'получили бы (пробный подсчёт, без записи)';
  console.info(
    [
      `Строк без признаков взято: ${report.scanned}`,
      `  ${verb}: ${report.filled} (ИдФайл ${report.withFileId}, состав ${report.withContentKey})`,
      `  признаков нет и в XML: ${report.noKeys}`,
      `  строка изменилась за время чтения, не тронута: ${report.changed}`,
      `  сбоев: ${report.failures.length}${report.stopped ? ' — запуск прерван' : ''}`,
      ...report.failures.slice(0, 20).map((f) => `    ${f.id}: ${f.reason}`),
      ...(report.failures.length > 20 ? [`    … и ещё ${report.failures.length - 20}`] : []),
    ].join('\n'),
  );
  return report.failures.length || report.stopped ? 1 : 0;
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
