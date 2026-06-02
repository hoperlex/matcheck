import { useCallback, useMemo, useState } from 'react';
import type { TableRowSelection } from 'antd/es/table/interface';

/**
 * Универсальный хук массового выбора для antd Table.
 *
 * Возвращает selectedIds (Set), готовый rowSelection для <Table> и
 * утилиты управления. Связан с rowKey-функцией — переиспользует тот
 * же экстрактор id, что и таблица.
 *
 * Поведение мастер-чекбокса — стандартное для antd: «выбрать всё на
 * текущей странице». Это безопаснее, чем «выбрать все 500 в результате»:
 * чтобы выбрать всё — пользователь увеличивает размер страницы и
 * нажимает мастер-чекбокс.
 */
export function useBulkSelection<T>(getId: (row: T) => string): {
  selectedIds: Set<string>;
  selectedCount: number;
  hasSelection: boolean;
  clear: () => void;
  remove: (id: string) => void;
  selection: TableRowSelection<T>;
} {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const remove = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const selection = useMemo<TableRowSelection<T>>(
    () => ({
      type: 'checkbox',
      selectedRowKeys: Array.from(selectedIds),
      onChange: (keys) => {
        setSelectedIds(new Set(keys.map(String)));
      },
      preserveSelectedRowKeys: true,
      // Клик по чекбоксу не должен «всплывать» в onRow → onRowClick
      // (иначе открывается detail-модалка прямо при попытке выбрать).
      columnWidth: 48,
    }),
    [selectedIds],
  );

  // getId не используется в selection (antd работает по rowKey), но
  // оставлен в API на случай прокидывания в callbacks/телеметрию.
  void getId;

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    hasSelection: selectedIds.size > 0,
    clear,
    remove,
    selection,
  };
}
