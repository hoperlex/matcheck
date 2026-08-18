/**
 * Выкатной прогон новой модели машины. ЗАПУСКАТЬ ПОСЛЕ включения GROUPS_ROLLOUT.
 *
 * Зачем нужен отдельный скрипт, если правило вычисляемое. Оба поля, которые
 * меняет выкат, планшет получает ТОЛЬКО дельтой `/sync`, а дельта отбирает по
 * `source_documents.updated_at` и по времени события видимости. Само включение
 * рубильника не пишет в базу ни строки: `group_id` начинает считаться иначе, а
 * отметки времени остаются прежними. Без этого прогона:
 *
 *   * дубликаты и прочее необработанное, уже лежащее в памяти планшетов, там и
 *     останется — новые метки удаления не появятся, а старые планшет пропустил
 *     (их время ниже его курсора, см. selectVisibilityTombstones);
 *   * машины, собранные по новому правилу, не доедут — документы приедут только
 *     при следующей своей правке, то есть, возможно, никогда.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply.
 *
 * ПРИ ЗАДАННОЙ ОТСЕЧКЕ (GROUPS_ROLLOUT_SINCE) прогон почти ничего не делает, и
 * это правильно: старые пачки живут по прежним правилам, а новые приезжают на
 * планшет обычной дельтой — досылать им ничего не нужно. Полезным остаётся
 * детектор в конце. Скрипт нужен, если отсечку однажды снимут и правило
 * распространят на всё разом.
 *
 * Порядок важен: сначала метки удаления, потом подъём отметок. Наоборот нельзя —
 * подъём привезёт планшету документ заново, а метка удалит его лишь следующей
 * синхронизацией, и инспектор увидит мигание.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/rollout-document-groups.ts
 *   pnpm --filter @matcheck/api tsx scripts/rollout-document-groups.ts --apply
 *   pnpm --filter @matcheck/api tsx scripts/rollout-document-groups.ts --site <uuid> --apply
 */
import { sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { mobileVisibleWithinRolloutSql } from '../src/domain/sourceDocuments/mobile-visibility.js';
import { loadEnv } from '../src/lib/env.js';

/**
 * Постоянная метка прогона. По ней же считается идемпотентность: повторный
 * запуск не должен ни плодить события, ни поднимать версии второй раз — иначе
 * ночная перестраховка «прогоню ещё раз» рассылает всем планшетам лишнюю
 * дельту.
 */
const ROLLOUT_MARKER = 'rollout:groups-v1';
const BUMP_SETTING_KEY = 'rollout.groups_v1.bumped_at';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const siteFilter = argValue('--site');
  const site = siteFilter
    ? drSql`and source_documents.site_id = ${siteFilter}::uuid`
    : drSql``;

  if (!loadEnv().GROUPS_ROLLOUT) {
    // Не отказ, а предупреждение: скрипт останется корректным и при выключенном
    // рубильнике, но смысла в нём тогда нет — предикат считает видимость по
    // старому правилу, и метки уйдут не тем документам.
    console.warn(
      '[rollout] GROUPS_ROLLOUT выключен. Прогон рассчитан на включённый рубильник:\n' +
        '          сначала включите его, иначе метки и отметки посчитаются по прежнему правилу.',
    );
  }

  // ── 1. Метки удаления для того, что уже лежит на планшетах ────────────────
  //
  // Скрытые предикатом документы, у которых есть объект (без объекта планшет их
  // не получал и удалять нечего). Прямая вставка, а НЕ recordVisibilityTransitions:
  // тот пишет событие только на СМЕНУ состояния, а у этих документов последнее
  // событие уже 'hidden' — второго он не создаст, и планшет ничего не узнает.
  //
  // Объект берём с корневого пакета — по нему выборка меток фильтрует выдачу
  // инспектору; у документа объект мог смениться или быть очищен.
  const hiddenRows = await db.execute(drSql`
    select source_documents.id
      from source_documents
     where source_documents.is_technical = false
       and source_documents.site_id is not null
       ${site}
       and not (${mobileVisibleWithinRolloutSql()})
       and not exists (
         select 1 from source_document_visibility_events e
          where e.source_document_id = source_documents.id
            and e.reason = ${ROLLOUT_MARKER}
       )
  `);
  const hidden = [...hiddenRows] as Array<{ id: string }>;

  console.log(`[rollout] метки удаления: ${hidden.length} документ(ов)`);

  if (apply && hidden.length > 0) {
    await db.execute(drSql`
      insert into source_document_visibility_events
        (source_document_id, visibility, site_id, group_id, reason, created_at)
      select source_documents.id,
             'hidden',
             coalesce(
               (select rb.site_id
                  from source_bundles sb
                  join source_bundles rb on rb.id = coalesce(sb.parent_bundle_id, sb.id)
                 where sb.id = source_documents.bundle_id),
               source_documents.site_id
             ),
             (select coalesce(sb.parent_bundle_id, sb.id)
                from source_bundles sb where sb.id = source_documents.bundle_id),
             ${ROLLOUT_MARKER},
             statement_timestamp()
        from source_documents
       where source_documents.is_technical = false
         and source_documents.site_id is not null
         ${site}
         and not (${mobileVisibleWithinRolloutSql()})
         and not exists (
           select 1 from source_document_visibility_events e
            where e.source_document_id = source_documents.id
              and e.reason = ${ROLLOUT_MARKER}
         )
    `);
    console.log('[rollout] метки записаны');
  }

  // ── 2. Подъём отметок у машин ─────────────────────────────────────────────
  //
  // Только публичные корни с двумя и более нетехническими документами: у
  // одиночного документа группа ничего не меняет, а лишняя дельта на боевом
  // объекте не бесплатна.
  const [already] = [
    ...(await db.execute(drSql`select value from settings where key = ${BUMP_SETTING_KEY}`)),
  ] as Array<{ value: unknown } | undefined>;

  // Та же отсечка, что и в правиле машины: пачки, принятые до выката, прогон не
  // трогает — они живут по прежним правилам, и поднимать им отметки значило бы
  // разослать планшетам изменения, которых мы как раз избегаем.
  const rolloutSince = loadEnv().GROUPS_ROLLOUT_SINCE;
  const notOlder = rolloutSince
    ? drSql`and root.created_at >= ${rolloutSince.toISOString()}::timestamptz`
    : drSql``;
  const machineRows = await db.execute(drSql`
    select root.id,
           count(*) filter (where d.is_technical = false) as docs
      from source_bundles root
      join source_bundles member on coalesce(member.parent_bundle_id, member.id) = root.id
      join source_documents d on d.bundle_id = member.id
     where root.parent_bundle_id is null
       ${notOlder}
       and exists (
         select 1 from ingest_events ie
          where ie.bundle_id = root.id and ie.channel = 'public'
       )
     group by root.id
    having count(*) filter (where d.is_technical = false) > 1
  `);
  const machines = [...machineRows] as Array<{ id: string; docs: number }>;

  if (already) {
    console.log(
      `[rollout] подъём отметок уже выполнялся (${BUMP_SETTING_KEY}) — пропускаем ` +
        `${machines.length} машин(ы)`,
    );
  } else {
    console.log(
      `[rollout] подъём отметок: ${machines.length} машин(ы), ` +
        `${machines.reduce((s, m) => s + Number(m.docs), 0)} документ(ов)`,
    );
  }

  if (apply && !already && machines.length > 0) {
    // По одной транзакции на машину: прогон идёт по боевой базе в рабочее окно,
    // и держать один длинный лок на все три сотни пакетов незачем.
    for (const m of machines) {
      await db.transaction(async (tx) => {
        await tx.execute(drSql`
          update source_bundles
             set group_revision = group_revision + 1,
                 updated_at = statement_timestamp()
           where id = ${m.id}::uuid
        `);
        await tx.execute(drSql`
          update source_documents sd
             set updated_at = statement_timestamp(),
                 version = sd.version + 1
            from source_bundles b
           where b.id = sd.bundle_id
             and coalesce(b.parent_bundle_id, b.id) = ${m.id}::uuid
             and sd.is_technical = false
        `);
      });
    }
    await db.execute(drSql`
      insert into settings (key, value)
      values (${BUMP_SETTING_KEY}, ${JSON.stringify({ machines: machines.length })}::jsonb)
      on conflict (key) do nothing
    `);
    console.log('[rollout] отметки подняты');
  }

  // ── 3. Детектор вместо блокировки ─────────────────────────────────────────
  //
  // Замена той проверки, которую мы сознательно НЕ ставим в предикат: машина
  // больше не ждёт неполно распознанные документы, поэтому теоретически возможен
  // случай «документ доехал после оформления приёмки». По боевым данным он не
  // встречался ни разу, но наблюдать за ним надо — молчаливая потеря материалов
  // хуже задержки.
  const lateRows = await db.execute(drSql`
    select source_documents.id,
           source_documents.doc_number,
           coalesce(b.parent_bundle_id, b.id) as root_id
      from source_documents
      join source_bundles b on b.id = source_documents.bundle_id
     where source_documents.is_technical = false
       and (${mobileVisibleWithinRolloutSql()})
       and not exists (
         select 1 from delivery_sources ds
          where ds.source_document_id = source_documents.id
       )
       and exists (
         select 1
           from delivery_sources ds
           join source_documents sib on sib.id = ds.source_document_id
           join source_bundles sb on sb.id = sib.bundle_id
          where coalesce(sb.parent_bundle_id, sb.id) = coalesce(b.parent_bundle_id, b.id)
       )
  `);
  const late = [...lateRows] as Array<{ id: string; doc_number: string | null; root_id: string }>;
  console.log(
    `[rollout] ДЕТЕКТОР: видимых документов в уже принятых машинах — ${late.length}` +
      (late.length ? ` (${late.map((r) => r.doc_number ?? r.id).join(', ')})` : ''),
  );

  const twiceRows = await db.execute(drSql`
    select coalesce(b.parent_bundle_id, b.id) as root_id,
           count(distinct ds.delivery_id) as deliveries
      from delivery_sources ds
      join source_documents d on d.id = ds.source_document_id
      join source_bundles b on b.id = d.bundle_id
     group by 1
    having count(distinct ds.delivery_id) > 1
  `);
  const twice = [...twiceRows] as Array<{ root_id: string; deliveries: number }>;
  console.log(`[rollout] ДЕТЕКТОР: машин с несколькими приёмками — ${twice.length}`);

  if (!apply) {
    console.log('\n[rollout] это был холостой прогон. Запись — с флагом --apply.');
  }
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
