/**
 * Состояние справочников поставщиков и подрядчиков — рабочий лист для чистки.
 * Только чтение; можно запускать под read-only ролью.
 *
 * Листы xlsx:
 *   - кандидаты в «Контрагенты»: часто покупатель или грузополучатель, но в
 *     списке нет (свои ИНН и битые ИНН не берутся);
 *   - ИНН для записей «Контрагентов» без ИНН — по документам с тем же именем;
 *   - ошибки «Контрагентов»: битый ИНН, своя организация, повтор ИНН;
 *   - поставщики, заведённые распознаванием, с ИНН своей организации или
 *     подрядчика;
 *   - операционные контрагенты, у которых под одним ИНН разные имена, и какую
 *     строку выберет «Подставить» (from-directory).
 *
 * Ничего не правит: кого добавить и какой ИНН вписать, решает человек
 * (часть «покупателей» — поставщики, прочитанные не из той графы).
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/directories-health-report.ts \
 *     --out /tmp/directories-health.xlsx [--days 180] [--min-docs 5]
 * На бою — в контейнере, как import-directories.ts:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api node_modules/.bin/tsx \
 *     scripts/directories-health-report.ts --out /data/directories-health.xlsx
 */
import { writeFile } from 'node:fs/promises';
import { db, sql } from '../src/db/client.js';
import {
  buildHealthReportXlsx,
  collectDirectoriesHealth,
} from '../src/domain/directories/health.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function main(): Promise<number> {
  const out = argValue('--out');
  const days = Number(argValue('--days') ?? '180');
  const minDocs = Number(argValue('--min-docs') ?? '5');
  if (!out) {
    console.error('нужен --out <файл.xlsx>');
    return 3;
  }
  if (!Number.isInteger(days) || days <= 0 || !Number.isInteger(minDocs) || minDocs <= 0) {
    console.error('--days и --min-docs — целые больше 0');
    return 3;
  }
  try {
    const h = await collectDirectoriesHealth(db, { days, minDocs });
    await writeFile(out, await buildHealthReportXlsx(h));
    console.info(`Свои ИНН: ${h.ownInns.join(', ') || 'нет (edo_accounts.org_inn пуст)'}`);
    console.info(
      `Кандидатов в подрядчики (≥${minDocs} док. за ${days} дн.): ${h.candidates.length}`,
    );
    console.info(`Записей «Контрагентов» без ИНН с ИНН по документам: ${h.innSuggestions.length}`);
    console.info(`Ошибок в «Контрагентах»: ${h.ccProblems.length}`);
    console.info(
      `Поставщиков с ИНН своей организации или подрядчика: ${h.supplierConflicts.length}`,
    );
    console.info(`Операционных ИНН с разными именами: ${h.operational.length}`);
    console.info(`Отчёт: ${out}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main();
