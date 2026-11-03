import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { api } from '../../services/api';
import { formatDateRu, formatDateTimeRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';
import { edoOperatorLabel } from '../shared/edoOperator';

type SourceKind = OperationSourceDocument['kind'];

/** УПД, которую привязывают к нескольким приёмкам. */
export type ShareEdoDocument = {
  source: 'import' | 'export';
  id: string;
  docNumber: string | null;
  docDate: string | null;
  operator?: string;
};

type Reason = 'match' | 'no_document' | 'selected' | 'search';

/** Строка подсказки (`GET /deliveries/:id/edo-share-candidates`). */
export type ShareCandidate = {
  deliveryId: string;
  displayId: number;
  arrivedAt: string | null;
  vehiclePlate: string | null;
  supplierName: string | null;
  documents: { id: string; kind: string; docNumber: string | null; docDate: string | null }[];
  photoNumbers: string[];
  otherEdo: { docNumber: string | null }[];
  state: 'linked' | 'available';
  reasons: Reason[];
  level: 'high' | 'possible' | 'weak';
  score: number;
  matches: string[];
  conflicts: string[];
  otherSupplier: boolean;
  defaultSectionId: string | null;
};

type Response = {
  document: {
    docNumber: string | null;
    docDate: string | null;
    supplierName: string | null;
    supplierInn: string | null;
    totalSum: string | null;
  };
  siteId: string;
  items: ShareCandidate[];
  truncated: boolean;
};

type BatchResponse = {
  linked: { deliveryId: string; displayId: number }[];
  alreadyLinked: { deliveryId: string; displayId: number }[];
};

/** Значение выбора «ко всей приёмке»: у Select нет null-значения. */
const WHOLE = '';

const LEVEL_TAG: Record<ShareCandidate['level'], { color: string; text: string }> = {
  high: { color: 'green', text: 'Сильное совпадение' },
  possible: { color: 'gold', text: 'Проверьте' },
  weak: { color: 'default', text: 'Мало совпадений' },
};

/** «к 3 приёмкам», «к 1 приёмке». */
function toDeliveries(n: number): string {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'приёмке' : 'приёмкам'}`;
}

/** Итог привязки для `message.success`. */
export function batchResultText(result: BatchResponse): string {
  if (!result.linked.length) return 'УПД уже была во всех выбранных приёмках';
  const already = result.alreadyLinked.length;
  return `УПД привязана к ${toDeliveries(result.linked.length)}${already ? `, в ${already} уже была` : ''}`;
}

/**
 * Окно «К другим приёмкам»: одна УПД из ЭДО — к нескольким приёмкам объекта
 * (одна УПД на несколько машин).
 *
 * Сервер подсказывает приёмки: тот же номер или поставщик, «без документа»
 * рядом по времени, отмеченные в списке (`preselected`) и найденные поиском.
 * Из карточки заранее не отмечено ничего — выбор за менеджером. Блок
 * материалов у каждой приёмки свой: по умолчанию её документ с тем же
 * номером, иначе — приёмка целиком. Привязка — всё или ничего.
 */
export function ShareEdoModal({
  open,
  anchorDeliveryId,
  document,
  preselected = [],
  onCancel,
  onDone,
  afterClose,
}: {
  open: boolean;
  /** Приёмка, из которой открыто окно: объект и права — по ней. */
  anchorDeliveryId: string | null;
  document: ShareEdoDocument | null;
  /** Приёмки, отмеченные в списке: показаны всегда и отмечены. */
  preselected?: readonly string[];
  onCancel: () => void;
  onDone: () => void;
  /** После анимации закрытия — здесь вызывающий чистит данные окна. */
  afterClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(preselected));
  const [sections, setSections] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const include = preselected.join(',');

  // Окно переиспользуется: при новом открытии — чистое состояние.
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setQuery('');
    setChecked(new Set(include ? include.split(',') : []));
    setSections(new Map());
    setError(null);
  }, [open, document?.id, include]);

  const candidates = useQuery({
    queryKey: [
      'delivery-edo-share',
      anchorDeliveryId,
      document?.source,
      document?.id,
      query,
      include,
    ],
    queryFn: () => {
      const params = new URLSearchParams({ source: document!.source, documentId: document!.id });
      if (query) params.set('q', query);
      if (include) params.set('include', include);
      return api.get<Response>(`/deliveries/${anchorDeliveryId}/edo-share-candidates?${params}`);
    },
    enabled: open && !!anchorDeliveryId && !!document,
  });
  const data = candidates.data;

  // Отмеченные приёмки помним между поисками: найденная поиском строка
  // добавляется к уже выбранным, а не заменяет их.
  const [known, setKnown] = useState<Map<string, ShareCandidate>>(() => new Map());
  useEffect(() => {
    if (!open) setKnown(new Map());
  }, [open]);
  useEffect(() => {
    if (!data) return;
    setKnown((prev) => {
      const next = new Map(prev);
      for (const row of data.items) next.set(row.deliveryId, row);
      return next;
    });
  }, [data]);

  const targets = useMemo(
    () =>
      [...checked]
        .map((id) => known.get(id))
        .filter((row): row is ShareCandidate => !!row && row.state === 'available')
        .map((row) => ({
          deliveryId: row.deliveryId,
          sectionDocumentId:
            (sections.has(row.deliveryId) ? sections.get(row.deliveryId) : row.defaultSectionId) ||
            null,
        })),
    [checked, known, sections],
  );

  const link = useMutation({
    mutationFn: () =>
      api.post<BatchResponse>(`/deliveries/${anchorDeliveryId}/edo-matches/batch`, {
        documentId: document!.id,
        source: document!.source,
        targets,
      }),
    onSuccess: async (result) => {
      message.success(batchResultText(result));
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['delivery-edo-matches'] }),
        queryClient.invalidateQueries({ queryKey: ['delivery-edo-candidates'] }),
        queryClient.invalidateQueries({ queryKey: ['delivery-edo-share'] }),
        queryClient.invalidateQueries({ queryKey: ['deliveries'] }),
      ]);
      onDone();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Не удалось привязать УПД'),
  });

  const toggle = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const rows = data?.items ?? [];
  const header = data?.document;
  const title = `УПД № ${document?.docNumber ?? 'без номера'}${
    document?.docDate ? ` от ${formatDateRu(document.docDate)}` : ''
  } — к другим приёмкам`;

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      afterClose={afterClose}
      title={title}
      width="min(1100px, 96vw)"
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onCancel} disabled={link.isPending}>
            Отмена
          </Button>
          <Button
            type="primary"
            disabled={!targets.length}
            loading={link.isPending}
            onClick={() => link.mutate()}
          >
            {targets.length ? `Привязать к ${toDeliveries(targets.length)}` : 'Привязать'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {header
            ? `${header.supplierName ?? 'Поставщик не указан'}${header.supplierInn ? ` (${header.supplierInn})` : ''}${
                header.totalSum ? ` · итого ${formatMoneyRu(Number(header.totalSum))}` : ''
              }${document?.operator ? ` · ${edoOperatorLabel(document.operator)}` : ''}. `
            : ''}
          Приёмки этого объекта: сверху — с тем же номером и поставщиком, ниже — без документа,
          ближайшие по времени. Отметьте, к каким ещё приёмкам относится эта УПД.
        </Typography.Text>
        <Input.Search
          allowClear
          placeholder="Поиск: № приёмки или номер авто"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            if (!event.target.value) setQuery('');
          }}
          onSearch={(value) => setQuery(value.trim())}
          style={{ maxWidth: 360 }}
        />
        {error && <Alert type="error" showIcon message={error} />}
        {candidates.isError && (
          <Alert
            type="error"
            showIcon
            message={
              candidates.error instanceof Error
                ? candidates.error.message
                : 'Не удалось загрузить приёмки'
            }
          />
        )}
        {data?.truncated && (
          <Alert type="info" showIcon message="Показаны не все приёмки — уточните поиском." />
        )}
        <Table<ShareCandidate>
          rowKey="deliveryId"
          size="small"
          pagination={false}
          loading={candidates.isLoading}
          dataSource={rows}
          locale={{
            emptyText: query
              ? 'Ничего не найдено'
              : 'Подходящих приёмок не нашлось — найдите поиском',
          }}
          rowSelection={{
            selectedRowKeys: rows
              .filter((row) => checked.has(row.deliveryId) && row.state === 'available')
              .map((row) => row.deliveryId),
            onSelect: (row, selected) => toggle(row.deliveryId, selected),
            onSelectAll: (selected, _rows, changed) =>
              changed.forEach((row) => toggle(row.deliveryId, selected)),
            getCheckboxProps: (row) => ({ disabled: row.state === 'linked' }),
          }}
          columns={[
            {
              title: 'Приёмка',
              key: 'delivery',
              width: 170,
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong type={row.state === 'linked' ? 'secondary' : undefined}>
                    {row.displayId}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {row.arrivedAt ? formatDateTimeRu(row.arrivedAt) : 'Без даты прибытия'}
                  </Typography.Text>
                  {row.vehiclePlate && (
                    <Typography.Text type="secondary">{row.vehiclePlate}</Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'Поставщик и документы',
              key: 'documents',
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.supplierName ?? '—'}</span>
                  {row.documents.map((doc) => (
                    <Typography.Text key={doc.id} type="secondary">
                      {sourceKindLabel(doc.kind as SourceKind)} № {doc.docNumber ?? 'без номера'}
                      {doc.docDate ? ` от ${formatDateRu(doc.docDate)}` : ''}
                    </Typography.Text>
                  ))}
                  {row.photoNumbers.length > 0 && (
                    <Typography.Text type="secondary">
                      На фото: № {row.photoNumbers.join(', ')}
                    </Typography.Text>
                  )}
                  {row.otherEdo.length > 0 && (
                    <Typography.Text type="secondary">
                      Уже есть УПД из ЭДО: №{' '}
                      {row.otherEdo.map((e) => e.docNumber ?? 'без номера').join(', ')}
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'Сверка',
              key: 'match',
              width: 260,
              render: (_value, row) => (
                <Space direction="vertical" size={2}>
                  <Space size={4} wrap>
                    {row.state === 'linked' ? (
                      <Tag>Уже привязана</Tag>
                    ) : row.reasons.includes('no_document') && !row.reasons.includes('match') ? (
                      <Tag color="blue">Без документа</Tag>
                    ) : (
                      <Tag color={LEVEL_TAG[row.level].color}>{LEVEL_TAG[row.level].text}</Tag>
                    )}
                    {row.otherSupplier && <Tag color="volcano">Другой поставщик</Tag>}
                    {row.reasons.includes('selected') && <Tag>Выбрана в списке</Tag>}
                  </Space>
                  {row.matches.length > 0 && row.state === 'available' && (
                    <Typography.Text type="secondary">
                      Совпало: {row.matches.join(', ')}
                    </Typography.Text>
                  )}
                  {row.conflicts.length > 0 && row.state === 'available' && (
                    <Typography.Text type="danger">{row.conflicts.join(', ')}</Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'Блок',
              key: 'section',
              width: 220,
              render: (_value, row) =>
                row.state === 'linked' ? null : (
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    aria-label={`Блок приёмки ${row.displayId}`}
                    value={sections.get(row.deliveryId) ?? row.defaultSectionId ?? WHOLE}
                    onChange={(value: string) =>
                      setSections((prev) => new Map(prev).set(row.deliveryId, value))
                    }
                    options={[
                      { value: WHOLE, label: 'Ко всей приёмке' },
                      ...row.documents.map((doc) => ({
                        value: doc.id,
                        label: `${sourceKindLabel(doc.kind as SourceKind)} № ${doc.docNumber ?? 'без номера'}`,
                      })),
                    ]}
                  />
                ),
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
