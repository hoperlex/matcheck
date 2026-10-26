import { useMemo, useState, type ReactNode } from 'react';
import { Button, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Delivery, Shipment, SourceDocumentDetail, Supplier } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { InlineEditChip } from '../../shared/ui/InlineEditChip';
import { upsertServerSnapshot as upsertDeliverySnapshot } from '../../services/deliveries';
import { upsertServerSnapshot as upsertShipmentSnapshot } from '../../services/shipments';
import type { UpdSupplierEditTarget } from './updSupplierName';
import { pickSupplierOptions, supplierInnMatchesDocument, supplierOptionLabel } from './supplierSearch';

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

  // Отбор, порядок и подписи — в supplierSearch. Фильтр один: у Select ниже
  // filterOption={false}, иначе antd вторично отфильтровал бы по подписи и
  // спрятал `АО "ИСТКУЛЬТ…` по запросу «АО И».
  const docInn = hasUpd ? (updEdit?.docInn ?? null) : null;
  const picked = useMemo(
    () => pickSupplierOptions(items, search, docInn),
    [items, search, docInn],
  );

  const supplierOptions = picked.map(({ supplier: s, group }) => ({
    value: s.id,
    label: supplierOptionLabel(s, group),
    // Битый ИНН не блокируем — только приглушаем: выбрать его можно, но он
    // не должен выглядеть равным настоящему.
    ...(group === 'invalid' ? { style: { opacity: 0.55 } } : {}),
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
            {updEdit.docInn && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ИНН поставщика в документе: {updEdit.docInn}
              </Typography.Text>
            )}
            <DocumentSupplierSelect
              docInn={updEdit.docInn}
              items={items}
              options={supplierOptions}
              loading={list.isLoading}
              notFound={notFound}
              onSearch={setSearch}
              onPick={(supplierDirectoryId) => {
                setDocumentSupplier.mutate({ docId: updEdit.docId, supplierDirectoryId });
                close();
              }}
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
          filterOption={false}
          loading={list.isLoading}
          options={supplierOptions}
          notFoundContent={notFound}
        />
      )}
    </InlineEditChip>
  );
}

/**
 * Выбор поставщика документа с переспросом при чужом ИНН.
 *
 * Если ИНН документа известен, а у выбранной записи он другой, PATCH не
 * уходит сразу: выбор откладывается до «Выбрать всё равно». Так 26.10
 * документ приёмки 21713 молча ушёл на дубль с битым ИНН. Отложенный выбор
 * живёт здесь, а не в чипе: окно уничтожает содержимое при закрытии
 * (destroyTooltipOnHide), и закрытие само его сбрасывает. Вложенная модалка
 * не годится — карточка открывается и внутри модалки «Операций», а вложенная
 * antd-модалка ломает ESC внешней.
 */
function DocumentSupplierSelect({
  docInn,
  items,
  options,
  loading,
  notFound,
  onSearch,
  onPick,
}: {
  docInn: string | null;
  items: Supplier[];
  options: { value: string; label: string }[];
  loading: boolean;
  notFound: ReactNode;
  onSearch: (value: string) => void;
  onPick: (supplierDirectoryId: string) => void;
}): JSX.Element {
  const [pending, setPending] = useState<Supplier | null>(null);

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Select<string>
        autoFocus
        aria-label="Поставщик в документе"
        style={{ width: '100%' }}
        placeholder="Выберите поставщика"
        value={undefined}
        onChange={(v) => {
          const chosen = items.find((s) => s.id === v);
          if (docInn && chosen && !supplierInnMatchesDocument(chosen.inn, docInn)) {
            setPending(chosen);
            return;
          }
          onPick(v);
        }}
        onSearch={onSearch}
        showSearch
        filterOption={false}
        loading={loading}
        options={options}
        notFoundContent={notFound}
      />
      {pending && docInn && (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            У записи «{pending.name}» ИНН {pending.inn || 'не указан'} — не совпадает с ИНН в
            документе {docInn}.
          </Typography.Text>
          <Space size={8}>
            <Button
              size="small"
              danger
              onClick={() => {
                const id = pending.id;
                setPending(null);
                onPick(id);
              }}
            >
              Выбрать всё равно
            </Button>
            <Button size="small" onClick={() => setPending(null)}>
              Отмена
            </Button>
          </Space>
        </Space>
      )}
    </Space>
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

