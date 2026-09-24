/**
 * С какой даты осматривать ящик.
 *
 * По умолчанию сервер берёт `backfill_since` — момент заведения учётной записи.
 * Для разведки этого мало: подключение может быть сделано сегодня, а понять
 * нужно, что лежит в ящике вообще — какие типы документов, какие версии
 * формата. Поэтому период выбирается явно и уходит в запрос параметром.
 *
 * Отсечку ИМПОРТА (`backfill_since`) это не трогает: осмотр ничего не пишет,
 * кроме собственного отчёта, и менять ради него глубину импорта значило бы
 * потом незаметно затянуть в портал историю за квартал.
 */
export type InventoryPeriod = 'connected' | 'd30' | 'd90' | 'd365';

export const INVENTORY_PERIODS: { value: InventoryPeriod; label: string }[] = [
  { value: 'connected', label: 'С момента подключения' },
  { value: 'd30', label: 'За 30 дней' },
  { value: 'd90', label: 'За 90 дней' },
  { value: 'd365', label: 'За год' },
];

const DAYS: Record<Exclude<InventoryPeriod, 'connected'>, number> = {
  d30: 30,
  d90: 90,
  d365: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Возвращает значение для параметра `since` или `undefined`, если период не
 * задаётся явно — тогда сервер сам возьмёт отсечку учётной записи.
 */
export function inventorySince(period: InventoryPeriod, now: Date = new Date()): string | undefined {
  if (period === 'connected') return undefined;
  return new Date(now.getTime() - DAYS[period] * DAY_MS).toISOString();
}
