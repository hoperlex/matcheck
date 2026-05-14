import { useEffect, useMemo, useState } from 'react';
import { Card, Progress, Select, Space, Tag, Typography } from 'antd';
import {
  DEFAULT_VEHICLE_ID,
  VEHICLE_TYPES,
  findVehicleType,
  type VehicleTypeId,
} from '../../shared/constants/vehicleTypes';

const LS_KEY = 'kpp:lastVehicleType';

export type VehicleFillItem = {
  qty: number;
  volumeM3: number | null;
  massKg: number | null;
};

type Props = {
  items: VehicleFillItem[];
};

function pctColor(pct: number): string {
  if (pct > 100) return '#cf1322';
  if (pct >= 75) return '#fa8c16';
  if (pct >= 50) return '#52c41a';
  if (pct >= 25) return '#1677ff';
  return '#bfbfbf';
}

function formatNumber(n: number, frac = 1): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: frac, minimumFractionDigits: 0 });
}

export function VehicleFillGauge({ items }: Props) {
  const [vehicleId, setVehicleId] = useState<VehicleTypeId>(() => {
    if (typeof window === 'undefined') return DEFAULT_VEHICLE_ID;
    const stored = window.localStorage.getItem(LS_KEY);
    return (stored as VehicleTypeId | null) ?? DEFAULT_VEHICLE_ID;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_KEY, vehicleId);
    } catch {
      /* ignore quota */
    }
  }, [vehicleId]);

  const vehicle = findVehicleType(vehicleId);

  const { totalVolume, totalMassT, unestimatedCount, hasAnyVolume, hasAnyMass } = useMemo(() => {
    let volume = 0;
    let massKg = 0;
    let unestimated = 0;
    let anyV = false;
    let anyM = false;
    for (const it of items) {
      if (it.volumeM3 != null) {
        volume += it.volumeM3 * it.qty;
        anyV = true;
      } else {
        unestimated += 1;
      }
      if (it.massKg != null) {
        massKg += it.massKg * it.qty;
        anyM = true;
      }
    }
    return {
      totalVolume: volume,
      totalMassT: massKg / 1000,
      unestimatedCount: unestimated,
      hasAnyVolume: anyV,
      hasAnyMass: anyM,
    };
  }, [items]);

  const volumePct = hasAnyVolume ? (totalVolume / vehicle.volumeM3) * 100 : 0;
  const massPct = hasAnyMass ? (totalMassT / vehicle.payloadTons) * 100 : 0;
  const limiting: 'volume' | 'mass' | null =
    hasAnyVolume || hasAnyMass ? (volumePct >= massPct ? 'volume' : 'mass') : null;

  return (
    <Card size="small" title="Объём и масса груза" styles={{ body: { padding: 12 } }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Select<VehicleTypeId>
          value={vehicleId}
          onChange={setVehicleId}
          style={{ width: '100%' }}
          options={VEHICLE_TYPES.map((v) => ({
            value: v.id,
            label: `${v.name} · ${v.volumeM3} м³ / ${v.payloadTons} т`,
          }))}
        />

        <GaugeBar
          label="Объём"
          unit="м³"
          actual={totalVolume}
          capacity={vehicle.volumeM3}
          pct={volumePct}
          empty={!hasAnyVolume}
          highlighted={limiting === 'volume'}
        />

        <GaugeBar
          label="Масса"
          unit="т"
          actual={totalMassT}
          capacity={vehicle.payloadTons}
          pct={massPct}
          empty={!hasAnyMass}
          highlighted={limiting === 'mass'}
        />

        {limiting && (volumePct > 0 || massPct > 0) && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Лимитирует <b>{limiting === 'volume' ? 'объём' : 'масса'}</b>
            {Math.max(volumePct, massPct) > 100 ? ' — перегруз, нужен кузов больше' : ''}
          </Typography.Text>
        )}
        {unestimatedCount > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Не оценено позиций: {unestimatedCount}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}

function GaugeBar({
  label,
  unit,
  actual,
  capacity,
  pct,
  empty,
  highlighted,
}: {
  label: string;
  unit: string;
  actual: number;
  capacity: number;
  pct: number;
  empty: boolean;
  highlighted: boolean;
}) {
  if (empty) {
    return (
      <div>
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Typography.Text strong>{label}</Typography.Text>
          <Tag color="default">не оценено</Tag>
        </Space>
        <Progress percent={0} showInfo={false} strokeColor="#d9d9d9" />
      </div>
    );
  }
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div
      style={
        highlighted
          ? {
              padding: 6,
              border: '2px solid ' + pctColor(pct),
              borderRadius: 8,
              transition: 'border-color 200ms',
            }
          : { padding: 6 }
      }
    >
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text>
          {formatNumber(actual)} / {formatNumber(capacity)} {unit} · {Math.round(pct)}%
        </Typography.Text>
      </Space>
      <Progress percent={clamped} showInfo={false} strokeColor={pctColor(pct)} />
    </div>
  );
}
