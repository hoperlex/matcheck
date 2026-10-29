import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Skeleton, Space, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliverySupplierOrdersResponse,
  EstimatOrderItemsResponse,
  EstimatSyncInfo,
  SupplierOrderCandidate,
  SupplierOrderCandidateDetail,
  SupplierOrderCandidatesResponse,
  SupplierOrderSiteMismatch,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import {
  APPROVAL_STATE_COLORS,
  approvalText,
  contractorsText,
  formatMsk,
  stageLabel,
} from '../../shared/utils/estimatOrder';
import { SupplierOrderDetails } from '../shared/SupplierOrderDetails';

const PAGE_SIZE = 20;
/** Колонка раскрытия строки: ширина явная, иначе сумма разойдётся со scroll.x. */
const EXPAND_COLUMN_WIDTH = 40;

/** Свежесть данных EstiMat одной строкой. */
export function syncInfoText(info: EstimatSyncInfo | undefined): string | null {
  if (!info) return null;
  if (!info.lastCompletedAt) {
    return info.enabled ? 'Заказы из EstiMat ещё не загружались.' : `Синхронизация с EstiMat выключена.`;
  }
  const base = `Данные EstiMat на ${formatMsk(info.lastCompletedAt)} (МСК).`;
  return info.lastOutcome === 'error' ? `${base} Последнее обновление закончилось ошибкой.` : base;
}

function matchTag(match: boolean | null, label: string) {
  if (match === true) return <Tag color="green">{label} совпадает</Tag>;
  if (match === false) return <Tag>{label} другой</Tag>;
  return null;
}

/**
 * Раскрытая строка подбора: подробности и состав заказа — двумя запросами, у
 * каждого свои загрузка и ошибка, чтобы сбой состава не прятал поля и наоборот.
 */
function CandidateDetails({ deliveryId, orderId }: { deliveryId: string; orderId: string }) {
  const detail = useQuery({
    queryKey: ['supplier-order-candidate', deliveryId, orderId],
    queryFn: () =>
      api.get<SupplierOrderCandidateDetail>(`/deliveries/${deliveryId}/supplier-order-candidates/${orderId}`),
    retry: false,
  });
  const items = useQuery({
    queryKey: ['supplier-order-candidate-items', deliveryId, orderId],
    queryFn: () =>
      api.get<EstimatOrderItemsResponse>(`/deliveries/${deliveryId}/supplier-order-candidates/${orderId}/items`),
    staleTime: 60_000,
    retry: false,
  });

  if (detail.isLoading) return <Skeleton active paragraph={{ rows: 4 }} />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <Alert type="warning" showIcon message="Заказ удалён в EstiMat или не найден — привязать его нельзя" />;
    }
    return (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить заказ"
        action={
          <Button size="small" onClick={() => void detail.refetch()}>
            Повторить
          </Button>
        }
      />
    );
  }
  if (!detail.data) return null;
  return <SupplierOrderDetails order={detail.data} items={items} descriptionColumns={2} deliveryLinkTarget="_blank" />;
}

/**
 * Окно подбора заказа EstiMat к приёмке. Пагинация и все отборы — на сервере:
 * по умолчанию заказы объекта приёмки в живых стадиях, сверху совпавшие по ИНН
 * поставщика и подрядчика. Совпадения только упорядочивают — выбирает человек.
 */
export function LinkSupplierOrderModal({
  open,
  deliveryId,
  onClose,
}: {
  open: boolean;
  deliveryId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [allSites, setAllSites] = useState(false);
  const [allStages, setAllStages] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Окно открыли заново — с начальными отборами.
  useEffect(() => {
    if (open) return;
    setSearch('');
    setQuery('');
    setAllSites(false);
    setAllStages(false);
    setPage(1);
    setError(null);
    setExpandedId(null);
  }, [open]);

  // Другой отбор или страница — другие строки: раскрытая могла исчезнуть.
  useEffect(() => {
    setExpandedId(null);
  }, [query, allSites, allStages, page]);

  const offset = (page - 1) * PAGE_SIZE;
  const candidates = useQuery({
    queryKey: ['delivery-supplier-order-candidates', deliveryId, query, allSites, allStages, offset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set('q', query);
      if (allSites) params.set('allSites', 'true');
      if (allStages) params.set('allStages', 'true');
      return api.get<SupplierOrderCandidatesResponse>(
        `/deliveries/${deliveryId}/supplier-order-candidates?${params.toString()}`,
      );
    },
    enabled: open && !!deliveryId,
  });

  const link = useMutation({
    mutationFn: (body: { orderId: string; confirmSiteMismatch?: boolean }) =>
      api.post<DeliverySupplierOrdersResponse>(`/deliveries/${deliveryId}/supplier-orders`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['delivery-supplier-orders', deliveryId], data);
      void queryClient.invalidateQueries({ queryKey: ['delivery-supplier-order-candidates', deliveryId] });
      onClose();
    },
  });

  const submit = async (candidate: SupplierOrderCandidate, confirmSiteMismatch: boolean) => {
    setError(null);
    try {
      await link.mutateAsync({ orderId: candidate.id, ...(confirmSiteMismatch ? { confirmSiteMismatch } : {}) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'site_mismatch') {
        const payload = err.payload as SupplierOrderSiteMismatch | undefined;
        Modal.confirm({
          // Статический метод не видит ConfigProvider — центрируем сами.
          centered: true,
          title: `Заказ ${candidate.number} другого объекта`,
          content: `${payload?.message ?? err.message}. Привязать всё равно?`,
          okText: 'Привязать',
          cancelText: 'Отмена',
          onOk: () => submit(candidate, true),
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Не удалось привязать заказ');
    }
  };

  const choose = (candidate: SupplierOrderCandidate) => {
    if (candidate.approvalState === 'cancelled' || candidate.approvalState === 'cancelling') {
      Modal.confirm({
        centered: true,
        title: `Заказ ${candidate.number}: ${candidate.approvalState === 'cancelled' ? 'отменён' : 'идёт отмена тендера'}`,
        content: 'Поставки по такому заказу, скорее всего, не будет. Привязать всё равно?',
        okText: 'Привязать',
        cancelText: 'Отмена',
        onOk: () => submit(candidate, false),
      });
      return;
    }
    void submit(candidate, false);
  };

  // Ширины явные, раскладка fixed: длинное название поставщика обрезается
  // многоточием с подсказкой, а метки совпадения под ним — никогда. Сумма с
  // колонкой раскрытия — 1248 px при «Все объекты»: столько вмещает окно на
  // экране 1390 px; уже — прокрутка, «Привязать» закреплена справа.
  const columns: ColumnsType<SupplierOrderCandidate> = [
    {
      title: '№',
      dataIndex: 'number',
      width: 84,
      render: (_v, r) => <Typography.Text strong>{r.number}</Typography.Text>,
    },
    {
      title: 'Стадия и виза',
      width: 190,
      render: (_v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={APPROVAL_STATE_COLORS[r.approvalState]} style={{ marginInlineEnd: 0 }}>
            {stageLabel(r.sourcingStatus)}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {approvalText(r)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Поставщик',
      width: 250,
      render: (_v, r) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text ellipsis={{ tooltip: r.supplierName ?? undefined }} style={{ display: 'block' }}>
            {r.supplierName ?? '— не выбран —'}
          </Typography.Text>
          <Space size={4} wrap>
            {r.supplierInn && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ИНН {r.supplierInn}
              </Typography.Text>
            )}
            {matchTag(r.supplierMatch, 'поставщик')}
          </Space>
        </Space>
      ),
    },
    {
      title: 'Подрядчик',
      width: 240,
      render: (_v, r) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Typography.Text ellipsis={{ tooltip: contractorsText(r) }} style={{ display: 'block' }}>
            {contractorsText(r)}
          </Typography.Text>
          {matchTag(r.contractorMatch, 'подрядчик')}
        </Space>
      ),
    },
    {
      title: 'Сумма',
      width: 124,
      align: 'right',
      render: (_v, r) => formatMoneyRu(r.amount),
    },
    ...(allSites
      ? [
          {
            title: 'Объект',
            width: 190,
            // Метка переносится, а не режется: код объекта в ней — главное.
            render: (_v: unknown, r: SupplierOrderCandidate) =>
              r.siteMatch ? (
                (r.siteCode ?? '—')
              ) : r.siteCode ? (
                <Tag color="orange" style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>
                  другой объект: {r.siteCode}
                </Tag>
              ) : (
                <Tag color="orange" style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>
                  объект EstiMat не найден{r.projectCode ? `: ${r.projectCode}` : ''}
                </Tag>
              ),
          },
        ]
      : []),
    {
      title: '',
      width: 130,
      // На узком экране таблица шире окна — кнопка не должна уезжать за край.
      fixed: 'right',
      render: (_v, r) =>
        r.linked ? (
          <Tag style={{ marginInlineEnd: 0 }}>Уже привязан</Tag>
        ) : (
          <Space direction="vertical" size={2}>
            <Button
              size="small"
              type="primary"
              onClick={(e) => {
                // Клик по строке раскрывает подробности — кнопка его не наследует.
                e.stopPropagation();
                choose(r);
              }}
              loading={link.isPending}
            >
              Привязать
            </Button>
            {r.linkedDeliveriesCount > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                уже в приёмках: {r.linkedDeliveriesCount}
              </Typography.Text>
            )}
          </Space>
        ),
    },
  ];

  const data = candidates.data;
  return (
    <Modal
      open={open}
      onCancel={() => {
        if (!link.isPending) onClose();
      }}
      title="Подобрать заказ EstiMat"
      width="min(1440px, 96vw)"
      footer={null}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Сверху — заказы, где совпал ИНН поставщика или подрядчика приёмки. Нажмите на строку, чтобы увидеть
          состав и подробности. {syncInfoText(data?.syncInfo)}
        </Typography.Text>
        {error && <Alert type="error" showIcon message={error} />}
        {candidates.isError && <Alert type="error" showIcon message="Не удалось загрузить заказы EstiMat" />}
        <Space wrap size="middle">
          <Input.Search
            placeholder="Номер (З-12, 12/1), поставщик, подрядчик или ИНН"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={(value) => {
              setQuery(value.trim());
              setPage(1);
            }}
            allowClear
            enterButton="Найти"
            style={{ width: 420 }}
          />
          <Space size={6}>
            <Switch
              checked={allSites}
              onChange={(v) => {
                setAllSites(v);
                setPage(1);
              }}
              aria-label="Все объекты"
            />
            <Typography.Text>Все объекты</Typography.Text>
          </Space>
          <Space size={6}>
            <Switch
              checked={allStages}
              onChange={(v) => {
                setAllStages(v);
                setPage(1);
              }}
              aria-label="Все стадии"
            />
            <Typography.Text>Все стадии</Typography.Text>
          </Space>
        </Space>
        <Table<SupplierOrderCandidate>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data?.items ?? []}
          loading={candidates.isLoading}
          tableLayout="fixed"
          scroll={{ x: allSites ? 1248 : 1058 }}
          onRow={() => ({ style: { cursor: 'pointer' } })}
          expandable={{
            columnWidth: EXPAND_COLUMN_WIDTH,
            expandRowByClick: true,
            expandedRowKeys: expandedId ? [expandedId] : [],
            onExpand: (expanded, r) => setExpandedId(expanded ? r.id : null),
            expandedRowRender: (r) =>
              deliveryId ? <CandidateDetails deliveryId={deliveryId} orderId={r.id} /> : null,
          }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            showSizeChanger: false,
            hideOnSinglePage: true,
            onChange: setPage,
          }}
          locale={{
            emptyText: query
              ? 'По запросу заказы не найдены'
              : allSites
                ? 'Подходящих заказов в EstiMat нет'
                : 'Заказов этого объекта нет. Включите «Все объекты» или «Все стадии».',
          }}
        />
      </Space>
    </Modal>
  );
}
