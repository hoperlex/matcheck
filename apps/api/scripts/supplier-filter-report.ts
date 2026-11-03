/**
 * Группы поставщиков перед выпуском: фильтр «Поставщик» и окно выбора в
 * карточке показывают одну строку на организацию вместо записей-дублей.
 * Только чтение; можно запускать под read-only ролью.
 *
 * Листы xlsx:
 *   - сводка: записей, строк выбора, повторы подписей (должно быть 0);
 *   - группы: участники групп из нескольких записей, основная и почему;
 *   - потери: что прежний фильтр по записи находил, а фильтр по группе — нет;
 *   - добавления: что фильтр по группе находит сверх прежнего по основной
 *     записи, и почему (документ на участнике / ИНН и имя / ИНН BillHub);
 *   - исключение BillHub: строки, найденные по ИНН записи BillHub при другом
 *     имени контрагента;
 *   - ограничение: имена с несколькими верными ИНН без двух ИНН BillHub —
 *     склеены в одну строку, среди них возможны настоящие тёзки;
 *   - сокращения: группы, склеенные свёрткой «ТОРГОВЫЙ ДОМ» → «ТД» и т. п.;
 *   - кандидаты в пары и «Пары — отклонено» — хвосты, которые группировка не
 *     склеивает («ТУЛА-СТАЛЬ» рядом с «ТД ТУЛА-СТАЛЬ», остаток тёзок): дубль →
 *     запись BillHub, если ИНН в ≤2 правках.
 *
 * --pairs-out <файл.csv> — те же кандидаты файлом для import-directories.ts
 * --merges-only --pairs. Все строки закомментированы: в склейку попадает
 * только то, что человек раскомментировал после просмотра.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/supplier-filter-report.ts \
 *     --out /tmp/supplier-filter.xlsx [--pairs-out /tmp/supplier-pairs.csv]
 * С adm1 по боевой базе: DATABASE_URL=$MATCHECK_DB_RO_URL (+ NODE_EXTRA_CA_CERTS).
 */
import { writeFile } from 'node:fs/promises';
import { db, sql } from '../src/db/client.js';
import {
  buildSupplierFilterReportXlsx,
  computeSupplierFilterReport,
  loadSupplierFilterReportInput,
  pairCandidatesCsv,
} from '../src/domain/directories/supplier-filter-report.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function main(): Promise<number> {
  const out = argValue('--out');
  const pairsOut = argValue('--pairs-out');
  if (!out) {
    console.error('нужен --out <файл.xlsx>');
    return 3;
  }
  try {
    const r = computeSupplierFilterReport(await loadSupplierFilterReportInput(db));
    await writeFile(out, await buildSupplierFilterReportXlsx(r));
    if (pairsOut) await writeFile(pairsOut, pairCandidatesCsv(r.pairCandidates));
    const multi = r.groups.filter((g) => g.memberIds.length > 1);
    console.info(`Записей справочника: ${r.suppliers}, строк выбора: ${r.groups.length}`);
    console.info(
      `Групп из нескольких записей: ${multi.length} (${multi.reduce((n, g) => n + g.memberIds.length, 0)} записей)`,
    );
    console.info(`Повторяющихся подписей: ${r.duplicateLabels.length}`);
    console.info(`Потери: ${r.lost.length}, добавления: ${r.added.length}`);
    console.info(`Только через ИНН BillHub: ${r.billhubException.length}`);
    console.info(`Ограничение (несколько верных ИНН): ${r.limitation.length} имён`);
    console.info(`Склеено сокращениями: ${r.abbreviations.length}`);
    console.info(
      `Кандидатов в ручные пары: ${r.pairCandidates.length}, отклонено: ${r.pairRejected.length}`,
    );
    if (pairsOut) console.info(`Пары (закомментированы): ${pairsOut}`);
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
