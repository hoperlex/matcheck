import { useMemo, useState } from 'react';
import { Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Delivery, Shipment, SourceDocumentDetail, Supplier } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { InlineEditChip } from '../../shared/ui/InlineEditChip';
import { upsertServerSnapshot as upsertDeliverySnapshot } from '../../services/deliveries';
import { upsertServerSnapshot as upsertShipmentSnapshot } from '../../services/shipments';
import type { UpdSupplierEditTarget } from './updSupplierName';

type ListResp = { items: Supplier[]; total: number };

/**
 * Чип «Поставщик» в шапке приёмки/отгрузки. Симметрично для двух сущностей,
 * чтобы UI приёмки и отгрузки выглядел одинаково (требование пользователя).
 *
 * Поведение:
 *  — `hasUpd=true` без `updEdit` → чип read-only, показывает имя из УПД
 *     (props.displayName). При наведении — tooltip «Поставщик из УПД».
 *  — `hasUpd=true` с `updEdit` → правка поставщика В САМОМ документе:
 *     PATCH /api/v1/source-documents/:docId { supplierDirectoryId }. Так
 *     исправляют неверно распознанного поставщика, и правка видна везде, где
 *     показывают документ, — во всех операциях, к которым он привязан.
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
  updEdit,
}: {
  entity: 'delivery' | 'shipment';
  entityId: string;
  hasUpd: boolean;
  /** Имя поставщика для отображения (берётся родителем из counterparty.name). */
  displayName: string | null;
  /** React-query key для invalidate после успешного выбора. */
  invalidateQueryKey: readonly unknown[];
  width?: number;
  /**
   * Запрет выбора поставщика САМОЙ операции (ветка без УПД). Правку документа
   * открывает не он, а наличие `updEdit`: у неё своё право.
   */
  disabled?: boolean;
  /** Документ, поставщика которого можно поправить, — см. updSupplierEditTarget. */
  updEdit?: UpdSupplierEditTarget & { onSaved: (doc: SourceDocumentDetail) => void };
}): JSX.Element {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['suppliers', 'directory'],
    queryFn: () => api.get<ListResp>('/suppliers?limit=5000'),
    // Справочник цельный, меняется редко — кэшируем подольше.
    staleTime: 5 * 60 * 1000,
    enabled: !hasUpd || !!updEdit,
  });
  const items = list.data?.items ?? [];

  const setSupplier = useMutation<Delivery | Shipment, Error, string | null>({
    mutationFn: (supplierDirectoryId) =>
      api.patch<Delivery | Shipment>(
        `/${entity === 'delivery' ? 'deliveries' : 'shipments'}/${entityId}/supplier-from-directory`,
        { supplierDirectoryId },
      ),
    onSuccess: async (updated) => {
      message.success('Поставщик обновлён');
      // КРИТИЧНО: обновляем IDB server snapshot из ответа бэка. Иначе
      // следующий save через offline-очередь возьмёт старый supplierId
      // из IDB и отправит его в /deliveries|/shipments — бэк перезапишет
      // только что выбранного поставщика обратно. То же делает linkUpd.
      if (entity === 'delivery') {
        await upsertDeliverySnapshot([updated as Delivery]);
      } else {
        await upsertShipmentSnapshot([updated as Shipment]);
      }
      await qc.invalidateQueries({ queryKey: invalidateQueryKey });
    },
    onError: (err) => {
      message.error(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    },
  });

  const setDocumentSupplier = useMutation<
    SourceDocumentDetail,
    Error,
    { docId: string; supplierDirectoryId: string }
  >({
    mutationFn: ({ docId, supplierDirectoryId }) =>
      api.patch<SourceDocumentDetail>(`/source-documents/${docId}`, { supplierDirectoryId }),
    onSuccess: async (doc) => {
      message.success('Поставщик в документе обновлён');
      // Сначала родителю: чип берёт имя из документа, который тот держит в
      // state, и без этого показывал бы прежнего поставщика до перезагрузки.
      updEdit?.onSaved(doc);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['source-documents'] }),
        qc.invalidateQueries({ queryKey: ['source-document', doc.id] }),
        qc.invalidateQueries({ queryKey: ['source-document-offline', doc.id] }),
        // Таблица операций показывает поставщика основного документа.
        qc.invalidateQueries({ queryKey: [entity === 'delivery' ? 'deliveries' : 'shipments'] }),
      ]);
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

  const supplierOptions = filtered.map((s) => ({
    value: s.id,
    label: s.inn ? `${s.name} · ИНН ${s.inn}` : s.name,
  }));
  const notFound = list.isLoading ? <Spin size="small" /> : 'Ничего не найдено';

  if (hasUpd && updEdit) {
    const operations = entity === 'delivery' ? 'приёмках' : 'отгрузках';
    const operation = entity === 'delivery' ? 'приёмке' : 'отгрузке';
    return (
      <InlineEditChip
        label="Поставщик"
        value={displayName}
        placeholder="— из УПД —"
        width={width}
        disabled={setDocumentSupplier.isPending}
      >
        {(close) => (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Поставщик в УПД №{updEdit.docNumber ?? '—'}
              {updEdit.docDate ? ` от ${updEdit.docDate}` : ''}. Меняется в самом документе — во
              всех {operations}, к которым он привязан.
            </Typography.Text>
            {updEdit.linkedCount > 1 && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                В {operation} документов: {updEdit.linkedCount}. Меняется только этот — его
                поставщик показан в чипе и в таблице.
              </Typography.Text>
            )}
            <Select<string>
              autoFocus
              aria-label="Поставщик в документе"
              style={{ width: '100%' }}
              placeholder="Выберите поставщика"
              value={undefined}
              onChange={(v) => {
                setDocumentSupplier.mutate({ docId: updEdit.docId, supplierDirectoryId: v });
                close();
              }}
              onSearch={setSearch}
              showSearch
              loading={list.isLoading}
              optionFilterProp="label"
              options={supplierOptions}
              notFoundContent={notFound}
            />
          </Space>
        )}
      </InlineEditChip>
    );
  }

  // hasUpd без права → read-only Tag. Не открывается, показывает подсказку.
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
          options={supplierOptions}
          notFoundContent={notFound}
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

