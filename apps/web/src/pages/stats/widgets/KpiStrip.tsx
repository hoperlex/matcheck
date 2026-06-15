import { Divider, Skeleton, Space, Statistic } from 'antd';
import type { StatsSummaryResponse } from '@matcheck/contracts';
import { formatMoneyRu } from '../../../shared/utils/formatRu';

interface Props {
  data: StatsSummaryResponse | undefined;
  loading: boolean;
}

/**
 * Плотная строка KPI без иконок и цветных плашек — по UX-ревью «не
 * маркетинговые карточки, а компактный Statistic с разделителями».
 * 6 метрик: Приёмки / Отгрузки / Машины / Сумма приёмок / Среднее в день /
 * Сегодня в процессе. Sum считаем только по приёмкам (у отгрузок цены
 * обычно нет — иначе бы размывало).
 */
export function KpiStrip({ data, loading }: Props) {
  if (loading && !data) {
    return <Skeleton.Input active style={{ width: '100%', height: 56 }} />;
  }
  if (!data) return null;
  const { kpi } = data;
  const Item = (props: { title: string; value: number | string; suffix?: string }) => (
    <Statistic
      title={<span style={{ fontSize: 12, color: '#8c8c8c' }}>{props.title}</span>}
      value={props.value}
      suffix={props.suffix}
      valueStyle={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}
    />
  );
  return (
    <Space
      split={<Divider type="vertical" style={{ height: 36 }} />}
      wrap
      size={[24, 12]}
      style={{ width: '100%', padding: '4px 0' }}
    >
      <Item title="Приёмки" value={kpi.deliveries} />
      <Item title="Отгрузки" value={kpi.shipments} />
      <Item title="Машин" value={kpi.vehicles} />
      <Item title="Сумма приёмок" value={formatMoneyRu(kpi.sumDeliveries)} />
      <Item title="Среднее в день" value={kpi.avgPerDay} />
      <Item title="Сегодня в процессе" value={kpi.inProgressToday} />
    </Space>
  );
}
