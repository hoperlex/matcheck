import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * «Липкие» фильтры между разделами портала. Если пользователь выбрал
 * Подрядчика=ООО Лютик в Приёмке, при переходе в Документы/Отгрузку/
 * Историю поступлений тот же фильтр должен подхватиться автоматически.
 *
 * Глобальными считаются только три фильтра: Подрядчик / Поставщик /
 * Объект — они присутствуют во всех списочных разделах.
 *
 * Поиск, статус, номер авто, направление и режим trash — остаются
 * локальными для каждого раздела.
 *
 * Persist в localStorage: переживает refresh страницы. URL остаётся
 * source of truth внутри раздела (deep-link побеждает), а store
 * лишь подхватывает фильтры при заходе без них.
 */
export interface GlobalFilters {
  contractorIds: string[];
  supplierIds: string[];
  siteIds: string[];
}

interface State extends GlobalFilters {
  set: (patch: Partial<GlobalFilters>) => void;
  reset: () => void;
}

const EMPTY: GlobalFilters = {
  contractorIds: [],
  supplierIds: [],
  siteIds: [],
};

export const useGlobalFiltersStore = create<State>()(
  persist(
    (set) => ({
      ...EMPTY,
      set: (patch) => set(patch),
      reset: () => set(EMPTY),
    }),
    {
      name: 'matcheck.global-filters',
      // Версия — чтобы безболезненно сбросить старые данные у пользователей.
      //
      // 2: «Документы» и «История поступлений» перешли на id справочников
      // заказчика (customer_counterparties / suppliers). До этого они клали сюда
      // id операционных counterparties, а соседние разделы — id справочников;
      // пересечения между таблицами нет, поэтому сохранённый выбор после
      // перехода в другой раздел давал пустой список и голый uuid в поле. Без
      // смены версии тот же мусор достался бы каждому, у кого фильтр уже
      // сохранён в localStorage.
      version: 2,
    },
  ),
);
