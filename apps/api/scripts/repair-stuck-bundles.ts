/**
 * Пакеты, зависшие в `processing`: диагностика и разовая починка.
 *
 * Откуда берутся. Router ставит пакету `processing`, если запустил сборку
 * логических УПД, рассчитывая, что до терминала его доведёт публикация. Ветка
 * ОТКАТА сборки этого не делала — чинила дочерний пакет, разворачивала файлы
 * обратно в документы, а статус корня не трогала. Пакет остаётся в `processing`
 * навсегда: `repairStuckJobs` ищет только `queued` и такой пакет не подбирает.
 * На боевой БД 14.08.2026 так зависли 7 пакетов, и это ровно все откаты сборки.
 *
 * Для поставщика это выглядит как вечное «в обработке» по тикету, для менеджера
 * — как незакрытый пакет; сами документы при этом созданы и распознаны.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply.
 *
 * Скрипт зовёт ТУ ЖЕ функцию, что воркер и периодический сторож
 * (`finalizeBundleTerminalState`), а не повторяет её SQL: разъехавшись, они
 * давали бы разный результат на одних и тех же данных.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/repair-stuck-bundles.ts
 *   pnpm --filter @matcheck/api tsx scripts/repair-stuck-bundles.ts --minutes 45
 *   pnpm --filter @matcheck/api tsx scripts/repair-stuck-bundles.ts --bundle <id>,<id> --apply
 *
 * Исходы:
 *   есть живой документ  → пакет `parsed` (файлы разложены, задания стояли);
 *   документов нет       → пакет `parse_failed`.
 *
 * Отдельный класс — «документы удалены человеком»: `created_document_ids`
 * указывают на записи из `entity_deletions`. Такие пакеты уходят в
 * `parse_failed`, и это правильно, но строки реестра НЕ переоткрываются:
 * менеджер уже закрыл вопрос, а S3-объекты удалённых документов вычищены.
 */
import { and, eq, inArray, sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { bundleImportItems, sourceBundles, sourceDocuments } from '../src/db/schema.js';
import {
  finalizeBundleTerminalState,
  selectStuckProcessingBundles,
} from '../src/domain/sourceDocuments/bundle-finalize.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const apply = process.argv.includes('--apply');
const minutes = Number(argValue('--minutes') ?? '45');
const bundlesArg = argValue('--bundle');
const limit = Number(argValue('--limit') ?? '50');

async function main(): Promise<void> {
  const ids = bundlesArg
    ? bundlesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : await selectStuckProcessingBundles(db, minutes, limit);

  if (ids.length === 0) {
    console.log(`Зависших пакетов не найдено (порог ${minutes} мин).`);
    await sql.end({ timeout: 5 });
    return;
  }

  console.log(`${apply ? 'ПОЧИНКА' : 'DRY-RUN'}: пакетов к обработке — ${ids.length}\n`);

  for (const id of ids) {
    const [bundle] = await db
      .select({
        id: sourceBundles.id,
        status: sourceBundles.status,
        createdAt: sourceBundles.createdAt,
        updatedAt: sourceBundles.updatedAt,
        docCount: sourceBundles.docCount,
        parseErrorMessage: sourceBundles.parseErrorMessage,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, id))
      .limit(1);
    if (!bundle) {
      console.log(`  [нет пакета] ${id}`);
      continue;
    }

    // Те же два источника живого документа, что и в finalizeBundleTerminalState.
    const [live] = await db
      .select({ n: drSql<number>`count(*)::int` })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.isTechnical, false),
          drSql`(${sourceDocuments.bundleId} = ${id} or ${sourceDocuments.bundleId} in (
                  select c.id from source_bundles c where c.parent_bundle_id = ${id}
                ))`,
        ),
      );
    const documents = live?.n ?? 0;

    // Документы, которые были и которые удалил человек: это НЕ потеря, и
    // переоткрывать по ним строки реестра нельзя.
    const [deleted] = await db
      .select({ n: drSql<number>`count(*)::int` })
      .from(bundleImportItems)
      .where(
        and(
          eq(bundleImportItems.bundleId, id),
          drSql`exists (
            select 1 from entity_deletions x
             where x.entity_type = 'source_document'
               and x.entity_id::text in (
                 select jsonb_array_elements_text(${bundleImportItems.createdDocumentIds})
               )
          )`,
        ),
      );

    const [items] = await db
      .select({ n: drSql<number>`count(*)::int` })
      .from(bundleImportItems)
      .where(
        and(
          eq(bundleImportItems.bundleId, id),
          inArray(bundleImportItems.status, ['accepted', 'uploading', 'needs_review']),
        ),
      );

    const ageMin = Math.round((Date.now() - bundle.updatedAt.getTime()) / 60000);
    const next = documents > 0 ? 'parsed' : 'parse_failed';
    const note = (deleted?.n ?? 0) > 0 ? '  ← документы удалены человеком' : '';

    console.log(`  ${id}`);
    console.log(
      `    ${bundle.status} → ${next}${note}\n` +
        `    без движения ${ageMin} мин · живых документов ${documents} · ` +
        `строк реестра к закрытию ${items?.n ?? 0}`,
    );
    if (bundle.parseErrorMessage) {
      console.log(`    причина: ${bundle.parseErrorMessage.slice(0, 100)}`);
    }

    if (apply) {
      const res = await finalizeBundleTerminalState(db, id, {
        itemReason: 'файл не дошёл до разбора (пакет закрыт разовой починкой)',
        parseErrorCode: 'not_finalized',
        parseErrorMessage: 'пакет остался в processing после отката сборки',
      });
      console.log(
        `    результат: ${res.outcome}${res.skipReason ? ` (${res.skipReason})` : ''}` +
          ` · закрыто строк ${res.finalizedItems}`,
      );
    }
    console.log();
  }

  if (!apply) console.log('Ничего не изменено. Для записи — повторить с --apply.');
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
