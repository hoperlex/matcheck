import { Column } from '@ant-design/plots';
import { Empty, Skeleton } from 'antd';
import type { StatsSummaryResponse } from '@matcheck/contracts';

interface Props {
  data: StatsSummaryResponse | undefined;
  loading: boolean;
}

// Цвета подобраны под UX-практику дашбордов: приёмки — синий (входящий
// поток), отгрузки — оранжевый (исходящий). Не перебивают akцент Antd.
const COLOR_DELIVERIES = '#1677ff';
const COLOR_SHIPMENTS = '#fa8c16';

/**
 * Stacked Column «Динамика по дням». Серии: Приёмки + Отгрузки.
 * Bar читается лучше line для дискретных дневных объёмов (см. UX-обзор).
 * Данные приходят с непрерывной серией дат — нулевые дни не пропущены,
 * поэтому ось X выглядит ровно. Высота ~260px — компактно над таблицей.
 */
export function DailyBarChart({ data, loading }: Props) {
  if (loading && !data) {
    return <Skeleton.Input active style={{ width: '100%', height: 260 }} />;
  }
  if (!data || data.daily.length === 0) {
    return <Empty description="Нет данных за период" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  // Разворачиваем в плоский массив с полем kind для stacking.
  const points = data.daily.flatMap((d) => [
    { date: d.date, kind: 'Приёмки', count: d.deliveries },
    { date: d.date, kind: 'Отгрузки', count: d.shipments },
  ]);
  return (
    <Column
      data={points}
      xField="date"
      yField="count"
      colorField="kind"
      stack
      height={260}
      scale={{
        color: { range: [COLOR_DELIVERIES, COLOR_SHIPMENTS] },
      }}
      axis={{
        x: {
          // Длинная серия дат (30) — поворачиваем подписи, чтобы не
          // перекрывались. Antd-plots сам прорежает тики при overflow.
          labelAutoRotate: true,
          labelFontSize: 10,
        },
        y: {
          labelFormatter: (v: number) => String(v),
        },
      }}
      legend={{
        color: { position: 'top', itemMarker: 'square' },
      }}
      // Цифры внутри столбиков не рисуем — на 30 точках это шум.
      // Tooltip антд-plots по умолчанию показывает значения по hover.
      tooltip={{
        title: 'date',
      }}
    />
  );
}
