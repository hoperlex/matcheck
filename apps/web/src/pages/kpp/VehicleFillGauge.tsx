import { useEffect, useMemo, useState, type FC } from 'react';
import { Card, Typography } from 'antd';
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

const VanIcon: FC = () => (
  <svg viewBox="0 0 64 32" width={52} height={26} fill="currentColor" aria-hidden="true">
    <path d="M4 8 H34 V24 H4 Z" />
    <path d="M34 12 H44 L48 18 V24 H34 Z" />
    <circle cx="14" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="42" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const TruckIcon: FC = () => (
  <svg viewBox="0 0 64 32" width={58} height={26} fill="currentColor" aria-hidden="true">
    <path d="M2 6 H42 V24 H2 Z" />
    <path d="M42 12 H54 L60 18 V24 H42 Z" />
    <circle cx="12" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="52" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const SemitrailIcon: FC = () => (
  <svg viewBox="0 0 64 32" width={60} height={26} fill="currentColor" aria-hidden="true">
    <path d="M2 8 H40 V24 H2 Z" />
    <path d="M40 14 H50 L56 20 V24 H40 Z" />
    <circle cx="10" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="28" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="49" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const EurotruckIcon: FC = () => (
  <svg viewBox="0 0 80 32" width={62} height={26} fill="currentColor" aria-hidden="true">
    <path d="M2 6 H50 V24 H2 Z" />
    <path d="M50 12 H62 L68 18 V24 H50 Z" />
    <circle cx="10" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="26" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="42" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
    <circle cx="60" cy="26" r="3.5" fill="#fff" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const VEHICLE_ICONS: Record<VehicleTypeId, FC> = {
  light: VanIcon,
  truck6m: TruckIcon,
  semitrail: SemitrailIcon,
  eurotruck: EurotruckIcon,
};

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
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            {VEHICLE_TYPES.map((v) => {
              const Icon = VEHICLE_ICONS[v.id];
              const selected = v.id === vehicleId;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVehicleId(v.id)}
                  aria-pressed={selected}
                  title={`${v.name} · ${v.volumeM3} м³ / ${v.payloadTons} т`}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    padding: '8px 4px',
                    minHeight: 72,
                    background: selected ? '#e6f4ff' : '#fff',
                    border: '1px solid ' + (selected ? '#1677ff' : '#d9d9d9'),
                    borderRadius: 6,
                    color: selected ? '#1677ff' : '#8c8c8c',
                    cursor: 'pointer',
                    transition: 'background 150ms, border-color 150ms, color 150ms',
                  }}
                >
                  <Icon />
                  <span
                    style={{
                      fontSize: 12,
                      color: selected ? '#1677ff' : '#000000d9',
                      fontWeight: selected ? 600 : 400,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {v.name}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <VBar
            label="Объём"
            unit="м³"
            actual={totalVolume}
            capacity={vehicle.volumeM3}
            pct={volumePct}
            empty={!hasAnyVolume}
            highlighted={limiting === 'volume'}
          />
          <VBar
            label="Масса"
            unit="т"
            actual={totalMassT}
            capacity={vehicle.payloadTons}
            pct={massPct}
            empty={!hasAnyMass}
            highlighted={limiting === 'mass'}
          />
        </div>
      </div>

      {limiting && (volumePct > 0 || massPct > 0) && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          Лимитирует <b>{limiting === 'volume' ? 'объём' : 'масса'}</b>
          {Math.max(volumePct, massPct) > 100 ? ' — перегруз, нужен кузов больше' : ''}
        </Typography.Text>
      )}
      {unestimatedCount > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          Не оценено позиций: {unestimatedCount}
        </Typography.Text>
      )}
    </Card>
  );
}

function VBar({
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
  const color = pctColor(pct);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        minWidth: 56,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: empty ? '#bfbfbf' : color,
          fontWeight: 600,
          lineHeight: 1,
        }}
      >
        {empty ? '—' : `${Math.round(pct)}%`}
      </span>
      <div
        style={{
          position: 'relative',
          width: 28,
          height: 96,
          border: '1px solid ' + (highlighted && !empty ? color : '#d9d9d9'),
          borderRadius: 4,
          background: '#fafafa',
          overflow: 'hidden',
          transition: 'border-color 200ms',
        }}
      >
        {!empty && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: `${Math.min(100, Math.max(0, pct))}%`,
              background: color,
              transition: 'height 200ms, background 200ms',
            }}
          />
        )}
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1 }}>{label}</span>
      <span style={{ fontSize: 11, color: '#8c8c8c', whiteSpace: 'nowrap', lineHeight: 1 }}>
        {empty ? 'не оценено' : `${formatNumber(actual)} / ${formatNumber(capacity)} ${unit}`}
      </span>
    </div>
  );
}
