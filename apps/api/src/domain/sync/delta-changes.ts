/**
 * Есть ли вообще что отдавать в дельте — один дешёвый запрос вместо сорока.
 *
 * Зачем. Обработчик `/sync` выполняет около сорока обращений к БД независимо от
 * того, изменилось ли хоть что-нибудь. По боевым логам типичный ответ —
 * `del=0 ship=0 sd=0`, то есть вся эта работа впустую, а планшеты опрашивают
 * ручку постоянно: SSE рассылается всем подключённым без скоупа, поэтому каждое
 * изменение на ЛЮБОМ объекте будит все устройства. Замер 25.08: 712 запросов за
 * полчаса, медиана 3321 мс, p90 5793 мс — одна эта ручка стабильно занимает
 * больше целого ядра, и из-за очереди медленным становится в том числе запрос,
 * который действительно везёт новую приёмку.
 *
 * Асимметрия ошибок здесь принципиальная и заложена намеренно:
 *
 *   * ложноположительный результат («вроде что-то есть», а дельта пустая) —
 *     безвреден: клиент получит обычный пустой ответ, как и раньше;
 *   * ложноотрицательный («ничего нет», хотя есть) — ПОТЕРЯ ДЕЛЬТЫ: клиент
 *     сдвинет курсор и больше не вернётся за этой записью.
 *
 * Поэтому проверяются ВСЕ источники, из которых обработчик что-либо берёт, а
 * сомнительные случаи трактуются в пользу «изменения есть». Отсюда же
 * отсутствие фильтров вроде `is_technical = false`: сузить условие означает
 * рискнуть пропуском, а лишнее срабатывание ничего не стоит.
 *
 * `statuses` в проверке нет сознательно: таблица фактически неизменяема и
 * колонки `updated_at` у неё вовсе не существует. Появится изменяемость —
 * появится и колонка, и строка здесь.
 *
 * Границу берём ту же (`>= since`), что и сам обработчик. Запись, закоммиченная
 * между этой проверкой и ответом, приедет следующей дельтой: курсор отдаётся с
 * прежним safety-overlap (`now − буфер`), то есть заведомо раньше момента
 * проверки.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

export async function hasDeltaChanges(
  db: Db,
  args: {
    /** Нижняя граница дельты — `since` клиента. */
    since: Date;
    /** Объект инспектора; null для admin/manager — они видят всё. */
    siteId: string | null;
  },
): Promise<boolean> {
  const since = args.since.toISOString();
  const site = args.siteId;

  // Скоуп по объекту — только там, где он есть у самой таблицы. Справочники
  // (контрагенты, материалы, объекты, МОЛ, ОС, единицы) глобальные: обработчик
  // отдаёт их без фильтра по объекту, значит и проверять их надо без него.
  const deliveryScope = site ? sql`and site_id = ${site}::uuid` : sql``;
  const shipmentScope = site ? sql`and site_id = ${site}::uuid` : sql``;
  const documentScope = site ? sql`and site_id = ${site}::uuid` : sql``;
  const visibilityScope = site ? sql`and site_id = ${site}::uuid` : sql``;
  // Удаления бывают двух видов: привязанные к объекту и глобальные
  // (справочники МОЛ и ОС, у них site_id IS NULL). Обработчик читает оба,
  // поэтому и проверка обязана видеть оба — иначе удаление справочной записи
  // не доедет до планшета никогда.
  const deletionScope = site ? sql`and (site_id = ${site}::uuid or site_id is null)` : sql``;

  const rows = await db.execute(sql`
    select (
         exists (select 1 from deliveries          where updated_at >= ${since}::timestamptz ${deliveryScope})
      or exists (select 1 from shipments           where updated_at >= ${since}::timestamptz ${shipmentScope})
      or exists (select 1 from source_documents    where updated_at >= ${since}::timestamptz ${documentScope})
      or exists (select 1 from counterparties      where updated_at >= ${since}::timestamptz)
      or exists (select 1 from materials           where updated_at >= ${since}::timestamptz)
      or exists (select 1 from sites               where updated_at >= ${since}::timestamptz)
      or exists (select 1 from responsible_persons where updated_at >= ${since}::timestamptz)
      or exists (select 1 from assets              where updated_at >= ${since}::timestamptz)
      or exists (select 1 from units               where updated_at >= ${since}::timestamptz)
      or exists (select 1 from entity_deletions    where deleted_at >= ${since}::timestamptz ${deletionScope})
      or exists (
           select 1 from source_document_visibility_events
            where created_at >= ${since}::timestamptz ${visibilityScope}
         )
    ) as changed
  `);

  const first = [...rows][0] as { changed: boolean } | undefined;
  // Нет строки — значит проверка не отработала как ожидалось. Трактуем как
  // «изменения есть»: лишний полный проход дешевле потерянной дельты.
  return first?.changed ?? true;
}
