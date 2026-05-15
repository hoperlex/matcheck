import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Counterparty,
  Site,
  SourceDirection,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api, ApiError } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { UpdPdfUploadModal } from './UpdPdfUploadModal';
import { UpdXmlUploadModal } from './UpdXmlUploadModal';
import { SourceDocumentDetailModal } from './SourceDocumentDetailModal';
import { UpdResolveDuplicateModal } from './UpdResolveDuplicateModal';

type List = z.infer<typeof SourceDocumentListResponseSchema>;
type Row = List['items'][number];

const UNFINISHED_STATUSES: ReadonlyArray<Row['status']> = [
  'queued',
  'processing',
  'needs_resolution',
];

type KindFilter = 'all' | 'upd' | 'request';

function StatusTag({ row, onResolve }: { row: Row; onResolve: (r: Row) => void }) {
  switch (row.status) {
    case 'queued':
      return <Tag color="blue">в очереди</Tag>;
    case 'processing':
      return (
        <Tag color="processing" icon={<LoadingOutlined />}>
          распознаётся
        </Tag>
      );
    case 'parsed':
      return <Tag color="green">обработано</Tag>;
    case 'parse_failed': {
      const msg =
        (row.parseErrorDetails as { message?: string } | null)?.message ?? row.parseErrorCode ?? 'ошибка';
      return (
        <Tooltip title={msg}>
          <Tag color="red" icon={<ExclamationCircleOutlined />}>
            ошибка
          </Tag>
        </Tooltip>
      );
    }
    case 'archived':
      return <Tag>архив</Tag>;
    case 'needs_resolution':
      if (row.parseErrorCode === 'duplicate_upd') {
        return (
          <Space size={4} wrap>
            <Tag color="orange">дубликат</Tag>
            <Button
              size="small"
              type="link"
              onClick={(e) => {
                e.stopPropagation();
                onResolve(row);
              }}
            >
              разрешить
            </Button>
          </Space>
        );
      }
      return (
        <Space size={4} wrap>
          <Tooltip
            title={
              (row.parseErrorDetails as { failedChecks?: unknown[] } | null)?.failedChecks
                ? 'Суммы по позициям не сходятся с шапкой документа'
                : undefined
            }
          >
            <Tag color="gold">суммы не сходятся</Tag>
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(row);
            }}
          >
            проверить
          </Button>
        </Space>
      );
    default:
      return <Tag>{row.status}</Tag>;
  }
}

function ConfidenceCell({ row }: { row: Row }) {
  if (row.status === 'queued' || row.status === 'processing') {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const c = row.llmConfidence != null ? Number(row.llmConfidence) : null;
  const hasMismatch = row.validation?.hasMismatch === true;
  return (
    <Space size={4}>
      {c != null ? <span>{Math.round(c * 100)}%</span> : <span>—</span>}
      {hasMismatch && (
        <Tooltip title="Сумма по позициям не сходится с шапкой">
          <WarningOutlined style={{ color: '#fa8c16' }} />
        </Tooltip>
      )}
    </Space>
  );
}

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  // direction/kind/q + контрагенты/объект — всё хранится в URL, чтобы фильтры
  // переживали F5 и поддерживали share-able ссылки.
  const direction: SourceDirection =
    params.get('direction') === 'outbound' ? 'outbound' : 'inbound';
  const kind: KindFilter = (() => {
    const k = params.get('kind');
    if (k === 'upd' || k === 'request') return k;
    return 'all';
  })();

  const filters: ListFiltersValue = {
    contractorId: params.get('contractor'),
    supplierId: params.get('supplier'),
    siteId: params.get('site'),
    q: params.get('q') ?? '',
  };

  const updateParams = (patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const updateFilters = (patch: Partial<ListFiltersValue>) => {
    updateParams({
      contractor: 'contractorId' in patch ? patch.contractorId : undefined,
      supplier: 'supplierId' in patch ? patch.supplierId : undefined,
      site: 'siteId' in patch ? patch.siteId : undefined,
      q: 'q' in patch ? patch.q : undefined,
    });
  };

  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [xmlModalOpen, setXmlModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['source-documents', { direction, kind, q: filters.q.trim() }],
    queryFn: () => {
      const qs = new URLSearchParams({ direction });
      if (kind !== 'all') qs.set('kind', kind);
      if (filters.q.trim()) qs.set('q', filters.q.trim());
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    // Поллинг, пока в выдаче есть «живые» документы (queued/processing/
    // needs_resolution). Когда всё «обработано» — поллинг останавливается.
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const hasUnfinished = items.some((x) => UNFINISHED_STATUSES.includes(x.status));
      return hasUnfinished ? 4000 : false;
    },
  });

  const counterpartiesQuery = useQuery({
    queryKey: ['counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: Counterparty[]; total: number }>('/counterparties?limit=500'),
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', 'all'],
    queryFn: () =>
      api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
  });

  // Оптимистическое удаление: строка мгновенно исчезает из таблицы, тост
  // показывается сразу, а DELETE-запрос летит в фоне. При ошибке (например
  // has_references) откатываем кэш через snapshot и показываем тост ошибки.
  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/source-documents/${id}`),
    // Сетевые сбои и 5xx — ретраим до 2 раз; 4xx (404, 409 has_references) —
    // бизнес-ошибки, ретрай не имеет смысла.
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return true;
    },
    onMutate: async (id: string) => {
      // Очищаем индикатор предыдущей ошибки для этой записи (повторная попытка).
      setDeleteErrors((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });

      // Отменяем активные refetch, иначе они затрут оптимистическое изменение.
      await qc.cancelQueries({ queryKey: ['source-documents'] });

      // Snapshot всех закэшированных списков (вариантов по direction/kind/...)
      // для возможного rollback.
      const snapshots = qc.getQueriesData<List>({ queryKey: ['source-documents'] });

      // Убираем удаляемую запись из всех закэшированных списков.
      qc.setQueriesData<List>({ queryKey: ['source-documents'] }, (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });

      // Если открыта модалка детали этого документа — закрываем.
      if (selectedId === id) setSelectedId(null);

      message.success('УПД удалён');

      return { snapshots };
    },
    onError: (err: Error, id, ctx) => {
      // Откат оптимистического изменения.
      const snapshots = (ctx as { snapshots?: Array<[readonly unknown[], List | undefined]> } | undefined)
        ?.snapshots;
      if (snapshots) {
        for (const [key, value] of snapshots) {
          qc.setQueryData(key, value);
        }
      }
      // Маркер ошибки на вернувшейся строке (виден до повторной попытки).
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    },
  });

  const allItems = list.data?.items ?? [];
  const filteredItems = useMemo(() => {
    return allItems.filter((r) => {
      if (filters.contractorId && r.contractorId !== filters.contractorId) return false;
      if (filters.supplierId && r.supplierId !== filters.supplierId) return false;
      if (filters.siteId && r.siteId !== filters.siteId) return false;
      return true;
    });
  }, [allItems, filters.contractorId, filters.supplierId, filters.siteId]);

  const renderDeleteButton = (r: Row) => {
    const errMsg = deleteErrors[r.id];
    return (
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        {errMsg && (
          <Tooltip title={errMsg}>
            <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
          </Tooltip>
        )}
        <Popconfirm
          title="Удалить УПД?"
          description="Документ, его позиции и оригинальный файл будут удалены безвозвратно."
          okText="Да, удалить"
          cancelText="Нет"
          okButtonProps={{ danger: true }}
          onConfirm={() => del.mutate(r.id)}
        >
          <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    );
  };

  const renderDocNumber = (v: string | null, r: Row) => {
    if (v) return v;
    if ((r.status === 'queued' || r.status === 'processing') && r.originalFilename) {
      return (
        <Typography.Text type="secondary" italic>
          {r.originalFilename}
        </Typography.Text>
      );
    }
    return '—';
  };

  return (
    <div>
      <Typography.Title level={3} style={{ margin: '0 0 12px' }}>
        Документы
      </Typography.Title>
      <Tabs
        activeKey={direction}
        onChange={(k) => updateParams({ direction: k === 'outbound' ? 'outbound' : null })}
        items={[
          { key: 'inbound', label: 'Приёмка' },
          { key: 'outbound', label: 'Отгрузка' },
        ]}
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <Segmented
          value={kind}
          onChange={(v) => {
            const next = v as KindFilter;
            updateParams({ kind: next === 'all' ? null : next });
          }}
          options={[
            { label: 'Все', value: 'all' },
            { label: 'УПД', value: 'upd' },
            { label: 'Заявки', value: 'request' },
          ]}
        />
        <Button type="primary" onClick={() => setXmlModalOpen(true)}>
          Загрузить УПД (XML)
        </Button>
        <Button onClick={() => setPdfModalOpen(true)}>Загрузить УПД (PDF)</Button>
        {list.isFetching && !list.isLoading && (
          <Spin size="small" indicator={<LoadingOutlined spin />} />
        )}
      </Space>
      <div style={{ marginBottom: 16 }}>
        <ListFilters
          value={filters}
          onChange={updateFilters}
          fields={['contractor', 'supplier', 'site', 'q']}
          counterparties={counterpartiesQuery.data?.items ?? []}
          sites={sitesQuery.data?.items ?? []}
          loading={counterpartiesQuery.isLoading || sitesQuery.isLoading}
          searchPlaceholder="Номер документа"
        />
      </div>
      <ResponsiveTable<Row>
        items={filteredItems}
        loading={list.isLoading}
        rowKey="id"
        onRowClick={(r) => setSelectedId(r.id)}
        columns={[
          {
            title: 'Тип',
            dataIndex: 'kind',
            render: (k: Row['kind']) => (
              <Tag color={k === 'upd' ? 'blue' : 'gold'}>{k === 'upd' ? 'УПД' : 'Заявка'}</Tag>
            ),
          },
          {
            title: 'Статус',
            dataIndex: 'status',
            render: (_: unknown, r: Row) => (
              <StatusTag row={r} onResolve={(row) => setResolveId(row.id)} />
            ),
          },
          {
            title: 'Уверенность',
            dataIndex: 'llmConfidence',
            render: (_: unknown, r: Row) => <ConfidenceCell row={r} />,
          },
          { title: '№', dataIndex: 'docNumber', render: renderDocNumber },
          { title: 'Дата', dataIndex: 'docDate', render: (v: string | null) => v ?? '—' },
          {
            title: 'Объект',
            dataIndex: 'siteName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Подрядчик',
            dataIndex: 'contractorName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Поставщик',
            dataIndex: 'supplierName',
            render: (v: string | null | undefined) => v ?? '—',
          },
          {
            title: 'Сумма',
            dataIndex: 'totalSum',
            render: (v: string | null) => formatDecimal(v) || '—',
          },
          { title: 'Происхождение', dataIndex: 'origin' },
          {
            title: '',
            key: 'actions',
            width: 56,
            align: 'right' as const,
            onCell: () => ({
              onClick: (e: MouseEvent) => e.stopPropagation(),
            }),
            render: (_: unknown, r: Row) => renderDeleteButton(r),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={2} style={{ width: '100%', position: 'relative' }}>
              <Space size={4} wrap>
                <Tag color={r.kind === 'upd' ? 'blue' : 'gold'}>
                  {r.kind === 'upd' ? 'УПД' : 'Заявка'}
                </Tag>
                <StatusTag row={r} onResolve={(row) => setResolveId(row.id)} />
              </Space>
              <Typography.Text strong>
                {r.docNumber ?? (r.originalFilename ? r.originalFilename : '— без номера —')}
              </Typography.Text>
              <Typography.Text type="secondary">
                {r.docDate ?? '—'} · {formatDecimal(r.totalSum) || '—'} ₽
                {r.llmConfidence != null
                  ? ` · уверенность ${Math.round(Number(r.llmConfidence) * 100)}%`
                  : ''}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.siteName ?? '—'} · {r.contractorName ?? '—'} · {r.supplierName ?? '—'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {r.origin}
              </Typography.Text>
              <div
                style={{ position: 'absolute', top: 0, right: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                {renderDeleteButton(r)}
              </div>
            </Space>
          </Card>
        )}
      />
      <UpdPdfUploadModal
        open={pdfModalOpen}
        direction={direction}
        onClose={() => setPdfModalOpen(false)}
      />
      <UpdXmlUploadModal
        open={xmlModalOpen}
        direction={direction}
        onClose={() => setXmlModalOpen(false)}
      />
      <SourceDocumentDetailModal
        id={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
      />
      <UpdResolveDuplicateModal
        id={resolveId}
        open={!!resolveId}
        onClose={() => setResolveId(null)}
      />
    </div>
  );
}
