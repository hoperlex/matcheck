import { authzRevisionOf, type UserDto } from '@matcheck/contracts';
import { getSetting, setSetting, withDb } from '../lib/db';
import { useGlobalFiltersStore } from '../stores/globalFilters';

/**
 * Ключ доступа, под которым наполнена локальная база браузера.
 *
 * Локальная база (IndexedDB) общая для всех вкладок и всех, кто входил в этом
 * браузере. Наблюдатель (observer) видит только свои объекты, а база могла
 * остаться от менеджера на том же компьютере или от его же прежней роли — со
 * всеми объектами. Поэтому при входе и при каждой смене профиля (смена роли,
 * объектов, каскадное удаление объекта — всё это меняет authzRevision)
 * сравниваем ключ, под которым база наполнена, с текущим.
 *
 * Чистим, только если наблюдатель участвует в переходе с любой стороны. Для
 * остальных ролей поведение прежнее: у инспектора в очереди могут лежать
 * неотправленные правки, и стирать их из-за смены объекта нельзя.
 */
const ACCESS_KEY = 'local_access_key';
const CURSOR_KEY = 'sync_cursor';

export function localAccessKeyOf(user: UserDto): string {
  return `${user.id}|${authzRevisionOf(user)}`;
}

function isObserverKey(key: string | null): boolean {
  return !!key && key.split('|')[1]?.startsWith('observer:') === true;
}

/** Хранилища с данными операций и объектов. Настройки (кроме курсора) не трогаем. */
const DATA_STORES = [
  'deliveries',
  'shipments',
  'source_documents',
  'photos',
  'mutations',
  'references',
] as const;

/**
 * Сверить ключ и при необходимости очистить локальную базу. Вызывать до старта
 * фоновой синхронизации. Возвращает true, если база очищена.
 */
export async function reconcileLocalAccess(user: UserDto): Promise<boolean> {
  const next = localAccessKeyOf(user);
  const prev = await getSetting<string>(ACCESS_KEY);
  if (prev === next) return false;
  const wipe = user.role === 'observer' || isObserverKey(prev);
  if (wipe) {
    await withDb(async (dbi) => {
      const tx = dbi.transaction([...DATA_STORES, 'settings'], 'readwrite');
      await Promise.all(DATA_STORES.map((name) => tx.objectStore(name).clear()));
      // Курсор синхронизации — вместе с данными: иначе следующий /sync
      // попросил бы только изменения после старой отметки и не вернул бы
      // очищенное.
      await tx.objectStore('settings').delete(CURSOR_KEY);
      await tx.done;
    });
  }
  await setSetting(ACCESS_KEY, next);
  return wipe;
}

/**
 * Запомненный фильтр «Объект» (localStorage, общий для всех, кто входил в этом
 * браузере) у наблюдателя сужается до его объектов. Иначе выбор, оставшийся от
 * другого человека, давал бы пустые списки: сервер пересекает фильтр со списком
 * наблюдателя, и чужой объект не вернёт ничего.
 */
export function narrowStickySiteFilter(user: UserDto): void {
  if (user.role !== 'observer') return;
  const allowed = new Set(user.siteIds ?? []);
  const state = useGlobalFiltersStore.getState();
  const next = state.siteIds.filter((id) => allowed.has(id));
  if (next.length !== state.siteIds.length) state.set({ siteIds: next });
}
