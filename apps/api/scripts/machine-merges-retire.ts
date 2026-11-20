/**
 * Снять все объединения машин — обслуживание и откат выпуска «Объединение
 * документов в одну машину».
 *
 * Зачем скрипт, а не DROP. Машина для планшета вычисляется на лету: убери
 * строки machine_merges молча — объединённые машины развалятся, а планшеты об
 * этом не узнают (документы не менялись, дельта /sync их не привезёт). Скрипт
 * снимает объединение так же, как «Разъединить»: ревизии отправок строго
 * растут, документы бампаются, пишутся переходы видимости.
 *
 * Машины с приёмкой тоже снимаются — без касания приёмок и связей. Это
 * безопасно: принятую машину планшет прячет целиком (у каждой её части есть
 * принятый документ), а непринятая часть честно вернётся отдельной карточкой.
 *
 * Порядок отката:
 *   1. MACHINE_MERGE_SITES= (пусто) и рестарт API — старые вкладки портала
 *      больше не объединят;
 *   2. этот скрипт с --apply;
 *   3. при выключении протокола — убрать объекты из GROUP_CLAIM_SITES;
 *   4. откат кода. Перед выключением GROUPS_ROLLOUT — тот же порядок.
 *
 * Запуск: DATABASE_URL=… npx tsx scripts/machine-merges-retire.ts [--apply]
 * Без --apply — только отчёт (dry-run).
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { retireMachineMerge } from '../src/domain/sourceDocuments/machine-merge.js';
import { withTxRetry } from '../src/lib/db-retry.js';

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const heads = await db.execute<{ head: string; members: number; accepted: boolean }>(sql`
    select mm.target_root_id as head,
           count(*)::int as members,
           exists (
             select 1
               from source_documents d
               join source_bundles b on b.id = d.bundle_id
               join delivery_sources ds on ds.source_document_id = d.id
              where coalesce(b.parent_bundle_id, b.id) in (
                      select mm.target_root_id
                      union all
                      select m2.member_root_id from machine_merges m2
                       where m2.target_root_id = mm.target_root_id
                    )
           ) as accepted
      from machine_merges mm
     group by mm.target_root_id
     order by mm.target_root_id
  `);
  const list = [...heads];
  console.info(
    `[retire] объединённых машин: ${list.length}, из них с приёмкой: ${list.filter((h) => h.accepted).length}`,
  );
  if (!apply) {
    for (const h of list) {
      console.info(`  ${h.head} · участников ${h.members}${h.accepted ? ' · есть приёмка' : ''}`);
    }
    console.info('[retire] dry-run: ничего не записано. Запустите с --apply.');
    return;
  }
  let done = 0;
  for (const h of list) {
    const res = await withTxRetry(() =>
      db.transaction((tx) => retireMachineMerge(tx as unknown as Db, h.head)),
    );
    if (res.changed) done++;
    console.info(
      `  ${h.head}: ${res.changed ? `снято, отправок ${res.rootIds.length}, документов ${res.documentIds.length}` : 'уже снято'}`,
    );
  }
  console.info(`[retire] снято объединений: ${done}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
