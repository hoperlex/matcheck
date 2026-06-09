import { useMemo, useState } from 'react';
import { Select, Spin, Tag, Tooltip, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Supplier } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { InlineEditChip } from '../../shared/ui/InlineEditChip';

type ListResp = { items: Supplier[]; total: number };

/**
 * Чип «Поставщик» в шапке приёмки/отгрузки. Симметрично для двух сущностей,
 * чтобы UI приёмки и отгрузки выглядел одинаково (требование пользователя).
 *
 * Поведение:
 *  — `hasUpd=true` → чип read-only, показывает имя из УПД (props.displayName).
 *     При попытке клика — tooltip «Поставщик берётся из УПД».
 *  — `hasUpd=false` → чип-edit: Select из /api/v1/suppliers (982 поставщика
 *     из справочника заказчика). При выборе бэк апсертит counterparty по
 *     ИНН и пишет её id в deliveries.supplier_id / shipments.supplier_id.
 *
 * `entity` определяет endpoint:
 *   delivery → PATCH /api/v1/deliveries/:id/supplier-from-directory
 *   shipment → PATCH /api/v1/shipments/:id/supplier-from-directory
 */
export function SupplierChip({
  entity,
  entityId,
  hasUpd,
  displayName,
  invalidateQueryKey,
  width = 320,
  disabled,
}: {
  entity: 'delivery' | 'shipment';
  entityId: string;
  hasUpd: boolean;
  /** Имя поставщика для отображения (берётся родителем из counterparty.name). */
  displayName: string | null;
  /** React-query key для invalidate после успешного выбора. */
  invalidateQueryKey: readonly unknown[];
  width?: number;
  disabled?: boolean;
}): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['suppliers', 'directory'],
    queryFn: () => api.get<ListResp>('/suppliers?limit=5000'),
    // Справочник цельный, меняется редко — кэшируем подольше.
    staleTime: 5 * 60 * 1000,
    enabled: !hasUpd,
  });
  const items = list.data?.items ?? [];

  const setSupplier = useMutation<unknown, Error, string | null>({
    mutationFn: (supplierDirectoryId) =>
      api.patch(`/${entity === 'delivery' ? 'deliveries' : 'shipments'}/${entityId}/supplier-from-directory`, {
        supplierDirectoryId,
      }),
    onSuccess: async () => {
      message.success('Поставщик обновлён');
      await qc.invalidateQueries({ queryKey: invalidateQueryKey });
    },
    onError: (err) => {
      message.error(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    },
  });

  const trimmed = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return items.slice(0, 200);
    return items
      .filter(
        (s) =>
          s.name.toLowerCase().includes(trimmed) ||
          (s.inn ?? '').toLowerCase().includes(trimmed),
      )
      .slice(0, 200);
  }, [items, trimmed]);

  // hasUpd → read-only Tag. Не открывается, показывает tooltip-подсказку.
  if (hasUpd) {
    return (
      <Tooltip title="Поставщик из УПД — изменить нельзя">
        <Tag color="default" style={{ marginInlineEnd: 0, cursor: 'help' }}>
          Поставщик: {displayName ?? '— из УПД —'}
        </Tag>
      </Tooltip>
    );
  }

  return (
    <InlineEditChip
      label="Поставщик"
      value={displayName}
      placeholder="— не указан —"
      width={width}
      disabled={disabled || setSupplier.isPending}
    >
      {(close) => (
        <Select<string>
          autoFocus
          style={{ width: '100%' }}
          placeholder="Выберите поставщика"
          value={undefined}
          onChange={(v) => {
            setSupplier.mutate(v ?? null);
            close();
          }}
          onSearch={setSearch}
          allowClear
          onClear={() => {
            setSupplier.mutate(null);
            close();
          }}
          showSearch
          loading={list.isLoading}
          optionFilterProp="label"
          options={filtered.map((s) => ({
            value: s.id,
            label: s.inn ? `${s.name} · ИНН ${s.inn}` : s.name,
          }))}
          notFoundContent={list.isLoading ? <Spin size="small" /> : 'Ничего не найдено'}
        />
      )}
    </InlineEditChip>
  );
}

/**
 * Хелпер: по supplierId (counterparty.id) находит имя в counterparties
 * списке. Возвращает null, если supplierId null или не найден в кэше.
 */
export function useSupplierDisplayName(
  supplierId: string | null,
  counterparties: { id: string; name: string }[],
): string | null {
  return useMemo(() => {
    if (!supplierId) return null;
    const c = counterparties.find((x) => x.id === supplierId);
    return c?.name ?? null;
  }, [supplierId, counterparties]);
}

