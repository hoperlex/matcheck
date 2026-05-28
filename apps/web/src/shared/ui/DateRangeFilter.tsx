import { useState } from 'react';
import { Button, DatePicker, Space } from 'antd';
import type { ColumnType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';

/**
 * Готовый набор props для antd Table column — фильтр по диапазону дат.
 * Применяется к колонке-строке (ISO `YYYY-MM-DD` или ISO datetime).
 *
 * Использование:
 * ```tsx
 * { title: 'Дата', dataIndex: 'docDate', ...dateRangeColumnFilter<Row>((r) => r.docDate) }
 * ```
 *
 * Внутри:
 * — `filterDropdown` рисует две DatePicker'а + «Сбросить» / «OK».
 * — `onFilter(value, row)` парсит ISO значение и сравнивает с диапазоном по
 *   локальному дню (без учёта часов).
 * — `filtered` помечает заголовок цветным значком при активном фильтре.
 */
export function dateRangeColumnFilter<T>(
  get: (row: T) => string | Date | null | undefined,
): Pick<ColumnType<T>, 'filterDropdown' | 'onFilter' | 'filtered'> {
  return {
    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
      <DateRangeDropdown
        selectedKeys={selectedKeys as React.Key[]}
        setSelectedKeys={(keys) => setSelectedKeys(keys as React.Key[])}
        confirm={() => confirm()}
        clearFilters={() => clearFilters?.()}
      />
    ),
    onFilter: (value, row) => {
      // value — это сериализованный ключ диапазона `from|to` (YYYY-MM-DD).
      // Может прийти как single key (одно значение) или несколько — берём
      // первый, остальные игнорируем (UI всегда ставит один ключ).
      const raw = typeof value === 'string' ? value : String(value);
      const [fromStr, toStr] = raw.split('|');
      const rowVal = get(row);
      if (!rowVal) return false;
      const day = dayjs(rowVal);
      if (!day.isValid()) return false;
      const dayStart = day.startOf('day');
      if (fromStr) {
        const from = dayjs(fromStr).startOf('day');
        if (dayStart.isBefore(from)) return false;
      }
      if (toStr) {
        const to = dayjs(toStr).endOf('day');
        if (dayStart.isAfter(to)) return false;
      }
      return true;
    },
    filtered: undefined,
  };
}

function DateRangeDropdown({
  selectedKeys,
  setSelectedKeys,
  confirm,
  clearFilters,
}: {
  selectedKeys: React.Key[];
  setSelectedKeys: (keys: React.Key[]) => void;
  confirm: () => void;
  clearFilters: () => void;
}) {
  const current = (() => {
    const k = selectedKeys[0];
    if (typeof k !== 'string') return [null, null] as [Dayjs | null, Dayjs | null];
    const [from, to] = k.split('|');
    return [
      from ? dayjs(from) : null,
      to ? dayjs(to) : null,
    ] as [Dayjs | null, Dayjs | null];
  })();
  const [from, setFrom] = useState<Dayjs | null>(current[0]);
  const [to, setTo] = useState<Dayjs | null>(current[1]);

  const apply = () => {
    if (!from && !to) {
      setSelectedKeys([]);
    } else {
      const f = from ? from.format('YYYY-MM-DD') : '';
      const t = to ? to.format('YYYY-MM-DD') : '';
      setSelectedKeys([`${f}|${t}`]);
    }
    confirm();
  };

  const reset = () => {
    setFrom(null);
    setTo(null);
    setSelectedKeys([]);
    clearFilters();
    confirm();
  };

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Space>
        <DatePicker
          value={from}
          onChange={setFrom}
          placeholder="С даты"
          format="DD.MM.YYYY"
          allowClear
        />
        <DatePicker
          value={to}
          onChange={setTo}
          placeholder="По дату"
          format="DD.MM.YYYY"
          allowClear
        />
      </Space>
      <Space style={{ justifyContent: 'flex-end' }}>
        <Button size="small" onClick={reset}>
          Сбросить
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          Применить
        </Button>
      </Space>
    </div>
  );
}
