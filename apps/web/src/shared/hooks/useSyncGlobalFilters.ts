import { useEffect, useRef } from 'react';
import { useGlobalFiltersStore, type GlobalFilters } from '../../stores/globalFilters';

/**
 * Двусторонняя синхронизация локальных фильтров раздела с глобальным
 * стором. Логика:
 *
 * 1. **Init (один раз при монтировании компонента)**: если все три фильтра
 *    в URL/локальном state пусты, а в сторе что-то лежит — поднимаем из
 *    стора и просим родителя применить (apply). Это даёт «липкость» при
 *    переходе между разделами.
 *
 * 2. **URL → store** (на каждое изменение фильтра): пишем актуальное
 *    значение в стор. После init этот эффект становится односторонним
 *    каналом URL → persistent storage. Глобальный стор НЕ пушит изменения
 *    обратно в URL после первой инициализации — это нарушило бы правило
 *    «URL побеждает» (открыли deep-link → видим именно его, не store).
 *
 * Важно: чтобы init-effect не зацепил ситуацию «пользователь специально
 * очистил все фильтры в текущем разделе», мы выполняем поднятие из стора
 * ровно один раз на монтирование. Если позже пользователь очистил всё —
 * никакого автозаполнения не происходит.
 */
export function useSyncGlobalFilters({
  current,
  apply,
}: {
  current: GlobalFilters;
  apply: (next: GlobalFilters) => void;
}): void {
  const initRef = useRef(false);
  const storeSet = useGlobalFiltersStore((s) => s.set);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const urlEmpty =
      current.contractorIds.length === 0 &&
      current.supplierIds.length === 0 &&
      current.siteIds.length === 0;
    if (!urlEmpty) return;
    // Читаем стор напрямую через getState — иначе зависимость на сторе
    // вызовет init-эффект при обновлении стора другим разделом.
    const s = useGlobalFiltersStore.getState();
    const storeHas =
      s.contractorIds.length > 0 || s.supplierIds.length > 0 || s.siteIds.length > 0;
    if (!storeHas) return;
    apply({
      contractorIds: s.contractorIds,
      supplierIds: s.supplierIds,
      siteIds: s.siteIds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // URL → store. Зависимости — стабильные ключи массивов (join'им чтобы
  // React сравнивал по значению, а не по ссылке).
  const cKey = current.contractorIds.join(',');
  const sKey = current.supplierIds.join(',');
  const stKey = current.siteIds.join(',');
  useEffect(() => {
    if (!initRef.current) return;
    storeSet({
      contractorIds: current.contractorIds,
      supplierIds: current.supplierIds,
      siteIds: current.siteIds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cKey, sKey, stKey]);
}

/**
 * Узкая версия для разделов, где поле «Поставщик» отсутствует (например,
 * История поступлений — фильтры только Объект + Подрядчик). Тут писать
 * supplierIds в стор нельзя — затрём чужой выбор. Поэтому только две
 * пары: подняли site/contractor при init, и далее отзеркаливаем их
 * туда-обратно. Стор-поле supplierIds никем не трогается.
 */
export function useSyncGlobalFiltersSiteContractor({
  siteIds,
  setSiteIds,
  contractorIds,
  setContractorIds,
}: {
  siteIds: string[];
  setSiteIds: (ids: string[]) => void;
  contractorIds: string[];
  setContractorIds: (ids: string[]) => void;
}): void {
  const initRef = useRef(false);
  const storeSet = useGlobalFiltersStore((s) => s.set);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    if (siteIds.length > 0 || contractorIds.length > 0) return;
    const s = useGlobalFiltersStore.getState();
    if (s.siteIds.length > 0) setSiteIds(s.siteIds);
    if (s.contractorIds.length > 0) setContractorIds(s.contractorIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stKey = siteIds.join(',');
  const cKey = contractorIds.join(',');
  useEffect(() => {
    if (!initRef.current) return;
    storeSet({ siteIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stKey]);
  useEffect(() => {
    if (!initRef.current) return;
    storeSet({ contractorIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cKey]);
}
