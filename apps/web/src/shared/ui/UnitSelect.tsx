import { useMemo } from 'react';
import { Select, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Unit } from '@matcheck/contracts';
import { api } from '../../services/api';

type ListResp = { items: Unit[]; total: number };

/**
 * Выпадающий список единиц измерения для столбца «Ед.» в редактируемых
 * позициях УПД / приёмок / отгрузок. Источник — справочник /units
 * (Справочники → «Ед-ы изм.»).
 *
 * Совместимость с legacy: если текущее value (`unit`-строка из БД) не
 * совпадает ни с одним кодом из справочника (например, «уп», «бухта»
 * 5-летней давности), оно показывается как virtual-опция. Пользователь
 * может оставить как есть или сменить на любой код из справочника.
 *
 * onChange отдаёт строку-код единицы (то же что хранится в `unit`),
 * не id из справочника — чтобы не ломать формат `delivery_items.unit`
 * и совместимость с мобильным клиентом, который шлёт строку.
 */
export function UnitSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Ед.',
  size = 'small',
  bordered = true,
  style,
  variant,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  size?: 'small' | 'middle' | 'large';
  bordered?: boolean;
  style?: React.CSSProperties;
  variant?: 'outlined' | 'borderless' | 'filled';
}): JSX.Element {
  const list = useQuery({
    queryKey: ['units', 'active'],
    queryFn: () => api.get<ListResp>('/units?activeOnly=true&limit=2000'),
    // Справочник стабилен, ~20 записей, агрессивно кэшируем.
    staleTime: 10 * 60 * 1000,
  });
  const units = list.data?.items ?? [];

  const options = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const u of units) {
      map.set(u.code, { value: u.code, label: u.code });
    }
    // Legacy: текущий unit не в справочнике — добавляем virtual-опцию,
    // помеченную «(не из справочника)» в подписи, чтобы пользователь
    // понимал что это устаревшее значение и мог сменить.
    if (value && value.length > 0 && !map.has(value)) {
      map.set(value, { value, label: `${value} (legacy)` });
    }
    return Array.from(map.values());
  }, [units, value]);

  return (
    <Select<string>
      value={value ?? undefined}
      onChange={(v) => onChange(v ?? null)}
      onClear={() => onChange(null)}
      placeholder={placeholder}
      size={size}
      // antd v5: bordered deprecated → variant; поддерживаем оба для совместимости.
      variant={variant ?? (bordered ? 'outlined' : 'borderless')}
      style={style}
      disabled={disabled}
      loading={list.isLoading}
      showSearch
      allowClear
      options={options}
      filterOption={(input, opt) =>
        String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
      }
      notFoundContent={list.isLoading ? <Spin size="small" /> : 'Ничего не найдено'}
    />
  );
}
