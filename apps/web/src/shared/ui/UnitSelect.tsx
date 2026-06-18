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

  // Нормализация для матчинга legacy-значений со справочником: убираем
  // регистр, пробелы и не-словарные символы. «М3» / «м3 » / « M3 » → «м3»
  // — все они мэтчатся с одной записью справочника, и virtual-опция с
  // суффиксом «(legacy)» в UI больше не показывается.
  const normalize = (s: string) =>
    s.trim().toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');

  const options = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const u of units) {
      map.set(u.code, { value: u.code, label: u.code });
    }
    // Если value не совпадает с активной записью справочника напрямую,
    // пробуем найти по нормализованному ключу — это покрывает большую
    // часть legacy-разнобоя из старых строк (регистр/пробелы/UTF-микс).
    if (value && value.length > 0 && !map.has(value)) {
      const normalizedValue = normalize(value);
      const matched = units.find((u) => normalize(u.code) === normalizedValue);
      if (matched) {
        // Точное legacy-значение, нормализуемое в существующий код, —
        // показываем выбранным официальный код из справочника, чтобы в
        // колонке «Ед.» отображалось чистое «м3» вместо устаревшего «М3».
        // ВАЖНО: хранимое в БД значение НЕ меняем здесь (см. onChange):
        // пока пользователь не сохранит, value остаётся как есть.
        map.set(value, { value, label: matched.code });
      } else {
        // Не нашли в справочнике — показываем как есть, БЕЗ технического
        // суффикса (legacy). Раздражает пользователей и не несёт смысла
        // в operational UI: достаточно того, что значение можно сменить.
        map.set(value, { value, label: value });
      }
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
