export type VehicleTypeId = 'light' | 'truck6m' | 'semitrail' | 'eurotruck';

export type VehicleType = {
  id: VehicleTypeId;
  name: string;
  volumeM3: number;
  payloadTons: number;
};

export const VEHICLE_TYPES: readonly VehicleType[] = [
  { id: 'light', name: 'Малотоннажник (Газель/HD)', volumeM3: 12, payloadTons: 1.8 },
  { id: 'truck6m', name: 'Грузовик 6м (фургон)', volumeM3: 38, payloadTons: 5 },
  { id: 'semitrail', name: 'Полуприцеп', volumeM3: 65, payloadTons: 12 },
  { id: 'eurotruck', name: 'Фура (евро)', volumeM3: 92, payloadTons: 22 },
] as const;

export const DEFAULT_VEHICLE_ID: VehicleTypeId = 'truck6m';

export function findVehicleType(id: string | null | undefined): VehicleType {
  return VEHICLE_TYPES.find((v) => v.id === id) ?? VEHICLE_TYPES[1]!;
}
