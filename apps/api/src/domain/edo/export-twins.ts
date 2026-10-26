/**
 * «Один документ» в нескольких представлениях — для подбора и привязки к приёмкам.
 *
 * Одна УПД может лежать в реестре дважды — копией из Диадока и копией из СБИС
 * (решение 22.10: показывать один раз, привязывать как один документ). Плюс
 * импортированная карточка Диадока — ещё одно её представление (связь со
 * строкой реестра — учётка/сообщение/вложение).
 *
 * Двойники — только между ОПЕРАТОРАМИ: повторы внутри Диадока (1 021 группа на
 * 22.10) не склеиваются — так решено 13.10, и поведение Диадока не меняется.
 * Признак двойника — тот же файл, тот же ИдФайл или тот же состав
 * (export-identity.ts); реквизиты шапки — не признак.
 *
 * Гонки. Привязка проверяет группу «внутри» advisory-блокировок по ключам
 * тождества: двойники по определению делят хотя бы один ключ, поэтому привязки
 * двух копий одной УПД идут строго по очереди, даже если копия СБИС появилась в
 * реестре посреди чужой транзакции (FOR UPDATE её не увидел бы). Ключи берутся
 * в одном отсортированном порядке на всех путях — без взаимных блокировок.
 */
import { sql as drSql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

type Exec = Pick<Db, 'execute'>;

export type EdoDocGroup = {
  /** Строки реестра группы: исходные и их копии у другого оператора. */
  exportIds: string[];
  /** Импортированные карточки группы (Диадок). */
  sourceIds: string[];
};

function uuidArray(values: readonly string[]): SQL {
  return values.length
    ? drSql`ARRAY[${drSql.join(values.map((v) => drSql`${v}`), drSql`, `)}]::uuid[]`
    : drSql`ARRAY[]::uuid[]`;
}

/**
 * Условие «tw — копия строки s у другого оператора» (обе — строки реестра,
 * ta/sa — их учётки). Строки, а не алиасы-таблицы: вызывающий подставляет имена.
 */
export function twinCondition(tw: string, ta: string, s: string, sa: string): SQL {
  return drSql.raw(`(${tw}.status = 'stored' and ${tw}.id <> ${s}.id
    and ${ta}.provider <> ${sa}.provider
    and (${tw}.content_sha256 = ${s}.content_sha256
      or (${s}.file_id is not null and ${tw}.file_id = ${s}.file_id)
      or (${s}.content_key is not null and ${tw}.content_key = ${s}.content_key)))`);
}

/** Строки реестра, с которых начинается группа: заданные и строки импортированных карточек. */
async function startRows(db: Exec, start: { exportIds?: string[]; sourceIds?: string[] }): Promise<string[]> {
  const exportIds = start.exportIds ?? [];
  const sourceIds = start.sourceIds ?? [];
  if (!sourceIds.length) return [...new Set(exportIds)];
  const rows = await db.execute<{ id: string }>(drSql`
    select e.id from edo_export_documents e
      join source_documents sd
        on sd.edo_account_id = e.edo_account_id and sd.provider_message_id = e.message_id
       and sd.provider_entity_id = e.entity_id
     where sd.id = any(${uuidArray(sourceIds)}) and sd.origin = 'edo_diadoc'`);
  return [...new Set([...exportIds, ...rows.map((r) => r.id)])];
}

/** Ключи тождества строк — для advisory-блокировок. Отсортированы. */
async function identityKeys(db: Exec, exportIds: readonly string[]): Promise<string[]> {
  if (!exportIds.length) return [];
  const rows = await db.execute<{ sha: string | null; fid: string | null; ck: string | null }>(drSql`
    select content_sha256 as sha, file_id as fid, content_key as ck
      from edo_export_documents where id = any(${uuidArray(exportIds)})`);
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.sha) keys.add(`sha:${r.sha}`);
    if (r.fid) keys.add(`fid:${r.fid}`);
    if (r.ck) keys.add(`ck:${r.ck}`);
  }
  return [...keys].sort();
}

/**
 * Взять блокировки по ключам тождества и посчитать группу. Вызывать внутри
 * транзакции привязки, ДО блокировок строк документов — порядок одинаковый на
 * всех путях: приёмка → ключи (по алфавиту) → строки.
 */
export async function lockEdoDocGroup(
  tx: Exec,
  start: { exportIds?: string[]; sourceIds?: string[] },
): Promise<EdoDocGroup> {
  const seeds = await startRows(tx, start);
  for (const key of await identityKeys(tx, seeds)) {
    await tx.execute(drSql`select pg_advisory_xact_lock(hashtextextended(${`edo-doc:${key}`}, 0))`);
  }
  return edoDocGroup(tx, start, seeds);
}

/** Группа без блокировок — для показа (подбор, «уже в приёмке»). */
export async function edoDocGroup(
  db: Exec,
  start: { exportIds?: string[]; sourceIds?: string[] },
  seeds?: string[],
): Promise<EdoDocGroup> {
  const startIds = seeds ?? (await startRows(db, start));
  const twins = startIds.length
    ? await db.execute<{ id: string }>(drSql`
        select distinct tw.id
          from edo_export_documents s
          join edo_accounts sa on sa.id = s.edo_account_id
          join edo_export_documents tw
            on tw.content_sha256 = s.content_sha256 or tw.file_id = s.file_id or tw.content_key = s.content_key
          join edo_accounts ta on ta.id = tw.edo_account_id
         where s.id = any(${uuidArray(startIds)}) and ${twinCondition('tw', 'ta', 's', 'sa')}`)
    : [];
  const exportIds = [...new Set([...startIds, ...twins.map((r) => r.id)])];
  const cards = exportIds.length
    ? await db.execute<{ id: string }>(drSql`
        select sd.id from source_documents sd
          join edo_export_documents e
            on e.edo_account_id = sd.edo_account_id and e.message_id = sd.provider_message_id
           and e.entity_id = sd.provider_entity_id
         where e.id = any(${uuidArray(exportIds)}) and sd.origin = 'edo_diadoc'`)
    : [];
  const sourceIds = [...new Set([...(start.sourceIds ?? []), ...cards.map((r) => r.id)])];
  return { exportIds, sourceIds };
}

/**
 * Где группа уже привязана: к этой приёмке и к другому объекту — приёмкой
 * другого объекта или карточкой, закреплённой за другим объектом.
 * `delivery.id` null — новая приёмка, «здесь» не бывает.
 */
export async function edoGroupLinks(
  db: Exec,
  group: EdoDocGroup,
  delivery: { id: string | null; siteId: string },
): Promise<{ linkedHere: boolean; foreignSite: boolean }> {
  const exp = uuidArray(group.exportIds);
  const src = uuidArray(group.sourceIds);
  const [row] = await db.execute<{ here: boolean; foreign: boolean }>(drSql`
    with links as (
      select dem.delivery_id from delivery_edo_matches dem
       where dem.export_document_id = any(${exp}) or dem.source_document_id = any(${src})
      union
      select ds.delivery_id from delivery_sources ds where ds.source_document_id = any(${src})
    )
    select
      exists (select 1 from links where delivery_id = ${delivery.id}::uuid) as here,
      (exists (select 1 from links l join deliveries d on d.id = l.delivery_id where d.site_id <> ${delivery.siteId})
        or exists (select 1 from source_documents sd
                    where sd.id = any(${src}) and sd.site_id is not null and sd.site_id <> ${delivery.siteId})) as foreign`);
  return { linkedHere: row?.here === true, foreignSite: row?.foreign === true };
}

/** Есть ли в группе импортированная карточка, к которой привязывают вместо строки реестра. */
export async function edoGroupHasImported(db: Exec, group: EdoDocGroup): Promise<boolean> {
  if (!group.sourceIds.length) return false;
  const [row] = await db.execute<{ found: boolean }>(drSql`
    select exists (
      select 1 from source_documents sd
       where sd.id = any(${uuidArray(group.sourceIds)}) and sd.origin = 'edo_diadoc'
         and sd.status = 'parsed' and sd.is_technical = false) as found`);
  return row?.found === true;
}
