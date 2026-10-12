import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Col, Input, Modal, Row, Space, Table, Tag, Typography, message } from 'antd';
import type { Delivery } from '@matcheck/contracts';
import { api } from '../../services/api';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { EdoCompareDrawer, type ComparePhoto } from './EdoCompareDrawer';

type FoundBy = 'number' | 'inn' | 'name' | 'date' | 'search';

type Candidate = {
  id: string;
  source: 'import' | 'export';
  contentCategory: string | null;
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  totalSum: string | null;
  siteId: string | null;
  usedElsewhere: number;
  foundBy: FoundBy[];
  reference: { origin: 'paper' | 'photo' | 'delivery'; label: string | null };
  score: number;
  level: 'high' | 'possible' | 'weak';
  matches: string[];
  conflicts: string[];
  missing: string[];
};

type Response = {
  items: Candidate[];
  referenceMissing: string[];
  truncated: FoundBy[];
  diagnostics: {
    registryReceivedUntil: string | null;
    innsAbsentInRegistry: string[];
    innUnreadable: boolean;
    contractorDelivery: boolean;
    dateOnly: boolean;
  };
};

type Preview = {
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  buyerName: string | null;
  buyerInn: string | null;
  totalSum: number | null;
  vatSum: number | null;
  shippedAt: string | null;
  items: {
    lineNo: number;
    nameRaw: string;
    qty: number;
    unit: string | null;
    price: number | null;
    sum: number | null;
  }[];
};

type DeliveryItem = Delivery['items'][number];

function referenceText(reference: Candidate['reference']): string {
  if (reference.origin === 'paper') return `Сверено с бумажной УПД № ${reference.label ?? '—'}`;
  if (reference.origin === 'photo') return `Сверено с фото УПД № ${reference.label ?? '—'}`;
  return 'Сверено с данными приёмки';
}

/** Позиции УПД рядом с позициями приёмки — сверка глазами до привязки. */
function CandidatePreview({
  deliveryId,
  candidate,
  deliveryItems,
}: {
  deliveryId: string;
  candidate: Candidate;
  deliveryItems: readonly DeliveryItem[];
}) {
  const preview = useQuery({
    queryKey: ['delivery-edo-preview', deliveryId, candidate.source, candidate.id],
    queryFn: () =>
      api.get<Preview>(
        `/deliveries/${deliveryId}/edo-candidates/${candidate.source}/${candidate.id}/preview`,
      ),
    staleTime: 5 * 60_000,
  });
  if (preview.isLoading) return <Typography.Text type="secondary">Читаем УПД…</Typography.Text>;
  if (preview.isError || !preview.data) {
    return (
      <Alert
        type="error"
        showIcon
        message={
          preview.error instanceof Error ? preview.error.message : 'Не удалось прочитать УПД'
        }
      />
    );
  }
  const doc = preview.data;
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        Продавец: {doc.supplierName ?? '—'} ({doc.supplierInn ?? 'ИНН не указан'}) · Покупатель:{' '}
        {doc.buyerName ?? '—'} ({doc.buyerInn ?? 'ИНН не указан'})
        {doc.shippedAt ? ` · Отгрузка ${formatDateRu(doc.shippedAt)}` : ''} · Итого{' '}
        {formatMoneyRu(doc.totalSum)}
      </Typography.Text>
      <Row gutter={16}>
        <Col span={14}>
          <Typography.Text strong>УПД из ЭДО</Typography.Text>
          <Table
            rowKey="lineNo"
            size="small"
            pagination={false}
            dataSource={doc.items}
            columns={[
              { title: '№', dataIndex: 'lineNo', width: 44 },
              { title: 'Наименование', dataIndex: 'nameRaw' },
              {
                title: 'Кол-во',
                key: 'qty',
                width: 110,
                render: (_v, item) => `${item.qty} ${item.unit ?? ''}`,
              },
              {
                title: 'Сумма',
                key: 'sum',
                width: 120,
                render: (_v, item) => formatMoneyRu(item.sum),
              },
            ]}
          />
        </Col>
        <Col span={10}>
          <Typography.Text strong>Приёмка</Typography.Text>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={[...deliveryItems]}
            locale={{ emptyText: 'В приёмке нет позиций' }}
            columns={[
              { title: 'Наименование', dataIndex: 'nameRaw' },
              {
                title: 'Кол-во',
                key: 'qty',
                width: 110,
                render: (_v, item) => `${item.qtyActual ?? item.qtyPlanned ?? '—'} ${item.unit}`,
              },
            ]}
          />
        </Col>
      </Row>
    </Space>
  );
}

export function LinkEdoDocumentModal({
  open,
  deliveryId,
  busy,
  error,
  deliveryItems,
  deliveryPhotos,
  onCancel,
  onPick,
}: {
  open: boolean;
  deliveryId: string | null;
  busy: boolean;
  error: string | null;
  deliveryItems: readonly DeliveryItem[];
  /** Серверные фото приёмки — для панели сверки. */
  deliveryPhotos: readonly ComparePhoto[];
  onCancel: () => void;
  onPick: (candidate: Candidate) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  /**
   * Панель сверки. Данные (compare) и видимость (compareOpen) разделены:
   * afterOpenChange(false) приходит только после анимации закрытия, и
   * очистка данных раньше размонтировала бы панель без возврата фокуса.
   * `candidate: null` — панель только с фото.
   */
  const [compare, setCompare] = useState<{ candidate: Candidate | null } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  /**
   * Узел внутри окна подбора: после закрытия панели фокус возвращается на его
   * .ant-modal-wrap, иначе следующий ESC окно не закроет. Панель живёт в
   * портале, поэтому найти обёртку через closest от неё нельзя.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const uploadedPhotos = deliveryPhotos.filter((p) => p.uploadedAt !== null).length;

  // Окно закрыли с открытой панелью: при следующем открытии её быть не должно.
  useEffect(() => {
    if (!open) {
      setCompareOpen(false);
      setCompare(null);
    }
  }, [open]);

  const openCompare = (candidate: Candidate | null) => {
    setCompare({ candidate });
    setCompareOpen(true);
  };
  const candidates = useQuery({
    queryKey: ['delivery-edo-candidates', deliveryId, query],
    queryFn: () =>
      api.get<Response>(
        `/deliveries/${deliveryId}/edo-candidates${query ? `?q=${encodeURIComponent(query)}` : ''}`,
      ),
    enabled: open && !!deliveryId,
  });
  const data = candidates.data;
  const diagnostics = data?.diagnostics;

  const choose = (candidate: Candidate) => {
    if (
      candidate.level !== 'high' ||
      candidate.conflicts.length ||
      candidate.missing.length ||
      candidate.usedElsewhere
    ) {
      Modal.confirm({
        title: `Привязать УПД ${candidate.docNumber ?? 'без номера'}?`,
        content: (
          <Space direction="vertical">
            {candidate.level !== 'high' && (
              <Typography.Text>
                Это не сильное совпадение — сверьте позиции и реквизиты по файлу.
              </Typography.Text>
            )}
            {candidate.conflicts.length > 0 && (
              <Typography.Text type="danger">
                Расхождения: {candidate.conflicts.join(', ')}.
              </Typography.Text>
            )}
            {candidate.missing.length > 0 && (
              <Typography.Text>
                Нет данных для сверки: {candidate.missing.join(', ')}.
              </Typography.Text>
            )}
            {candidate.usedElsewhere > 0 && (
              <Typography.Text>
                УПД уже привязана к {candidate.usedElsewhere} приёмкам.
              </Typography.Text>
            )}
          </Space>
        ),
        okText: 'Привязать',
        cancelText: 'Отмена',
        onOk: () => onPick(candidate),
      });
      return;
    }
    onPick(candidate);
  };

  /** Исходный файл в новой вкладке — XML, источник правды для PDF. */
  const openXml = async (candidate: Candidate) => {
    if (!deliveryId) return;
    const tab = window.open('about:blank', '_blank');
    try {
      const path =
        candidate.source === 'export'
          ? `/deliveries/${deliveryId}/edo-candidates/export/${candidate.id}/file`
          : `/source-documents/${candidate.id}/file`;
      const file = await api.get<{ url: string }>(path);
      if (tab) tab.location.href = file.url;
      else window.location.assign(file.url);
    } catch (err) {
      tab?.close();
      message.error(err instanceof Error ? err.message : 'Не удалось открыть файл УПД');
    }
  };

  /**
   * УПД из реестра — PDF рядом с фото приёмки. У импортированных PDF не
   * строится (на бою их нет), для них прежний путь — XML во вкладке.
   */
  const openFile = (candidate: Candidate) => {
    if (candidate.source === 'export') openCompare(candidate);
    else void openXml(candidate);
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="Подобрать УПД из ЭДО"
      width="min(1200px, 96vw)"
      footer={null}
      destroyOnClose
    >
      <Space ref={rootRef} direction="vertical" size="middle" style={{ width: '100%' }}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <Typography.Text type="secondary">
            Сверху — УПД с тем же номером и поставщиком. «Сильное совпадение» — только когда совпали
            полный номер, ИНН поставщика и дата. Раскройте строку, чтобы сверить позиции; «Открыть
            файл» покажет УПД рядом с фото приёмки.
            {diagnostics?.registryReceivedUntil
              ? ` В реестре ЭДО есть УПД, полученные по ${formatDateRu(diagnostics.registryReceivedUntil)}; более поздние ещё не выгружены.`
              : ''}
          </Typography.Text>
          <Button onClick={() => openCompare(null)} disabled={uploadedPhotos === 0}>
            Фото приёмки ({uploadedPhotos})
          </Button>
        </div>
        {error && <Alert type="error" message={error} showIcon />}
        {candidates.isError && (
          <Alert type="error" message="Не удалось загрузить УПД из ЭДО" showIcon />
        )}
        {diagnostics?.innUnreadable && (
          <Alert
            type="warning"
            showIcon
            message="ИНН поставщика в документе приёмки не проходит проверку — подбор идёт по номеру и названию."
          />
        )}
        {!!diagnostics?.innsAbsentInRegistry.length && (
          <Alert
            type="warning"
            showIcon
            message={`В текущем реестре ЭДО нет ни одной УПД с ИНН ${diagnostics.innsAbsentInRegistry.join(', ')}.`}
            description="Проверьте ИНН поставщика в приёмке или найдите УПД поиском по номеру или названию."
          />
        )}
        {diagnostics?.contractorDelivery && (
          <Alert
            type="info"
            showIcon
            message="Приёмка подрядчика: его УПД обычно приходят не в ящик ЭДО СУ-10."
          />
        )}
        {diagnostics?.dateOnly && !query && (
          <Alert
            type="warning"
            showIcon
            message="Нет ни номера УПД, ни поставщика — показаны УПД по дате приезда."
            description="Сверяйте по позициям или найдите нужную УПД поиском."
          />
        )}
        {!!data?.referenceMissing.length && (
          <Alert
            type="info"
            showIcon
            message={`Для точной сверки не хватает данных: ${data.referenceMissing.join(', ')}.`}
            description="Добавьте или исправьте УПД в разделе «Документы», если её реквизиты не распознаны."
          />
        )}
        {!!data?.truncated.length && (
          <Alert type="info" showIcon message="Показаны не все найденные УПД — уточните поиском." />
        )}
        <Input.Search
          placeholder="Номер УПД, поставщик, ИНН или имя файла"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onSearch={(value) => setQuery(value.trim())}
          allowClear
          enterButton="Найти"
        />
        <Table<Candidate>
          rowKey={(row) => `${row.source}:${row.id}`}
          dataSource={data?.items ?? []}
          loading={candidates.isLoading || busy}
          size="small"
          scroll={{ x: 950, y: '50vh' }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{
            expandedRowRender: (row) =>
              deliveryId ? (
                <CandidatePreview
                  deliveryId={deliveryId}
                  candidate={row}
                  deliveryItems={deliveryItems}
                />
              ) : null,
          }}
          locale={{
            emptyText: query
              ? 'По запросу УПД не найдены'
              : 'Подходящих УПД в реестре ЭДО не найдено. Попробуйте поиск по номеру или поставщику.',
          }}
          columns={[
            {
              title: 'УПД',
              key: 'document',
              width: 155,
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{row.docNumber ?? 'Без номера'}</Typography.Text>
                  <Typography.Text type="secondary">
                    {row.docDate ? formatDateRu(row.docDate) : 'Без даты'}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {row.source === 'export' ? 'XML из реестра ЭДО' : 'Импорт ЭДО'}
                  </Typography.Text>
                  {row.source === 'export' && row.contentCategory !== 'materials' && (
                    <Typography.Text type="warning">Состав требует проверки</Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'Поставщик',
              key: 'supplier',
              width: 200,
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <span>{row.supplierName ?? '—'}</span>
                  <Typography.Text type="secondary">
                    {row.supplierInn ?? 'ИНН не указан'}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: 'Сумма',
              key: 'sum',
              width: 120,
              render: (_value, row) => (row.totalSum ? formatMoneyRu(Number(row.totalSum)) : '—'),
            },
            {
              title: 'Сверка',
              key: 'match',
              render: (_value, row) => (
                <Space direction="vertical" size={2}>
                  <Tag
                    color={
                      row.level === 'high' ? 'green' : row.level === 'possible' ? 'gold' : 'default'
                    }
                  >
                    {row.level === 'high'
                      ? 'Сильное совпадение'
                      : row.level === 'possible'
                        ? 'Проверьте'
                        : 'Мало совпадений'}
                  </Tag>
                  <Typography.Text type="secondary">{referenceText(row.reference)}</Typography.Text>
                  {row.matches.length > 0 && (
                    <Typography.Text type="secondary">
                      Совпало: {row.matches.join(', ')}
                    </Typography.Text>
                  )}
                  {row.conflicts.length > 0 && (
                    <Typography.Text type="danger">{row.conflicts.join(', ')}</Typography.Text>
                  )}
                  {row.missing.length > 0 && (
                    <Typography.Text type="secondary">
                      Нет данных: {row.missing.join(', ')}
                    </Typography.Text>
                  )}
                  {row.usedElsewhere > 0 && (
                    <Typography.Text type="warning">
                      Уже в {row.usedElsewhere} приёмках
                    </Typography.Text>
                  )}
                </Space>
              ),
            },
            {
              title: '',
              key: 'pick',
              width: 120,
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <Button size="small" type="link" onClick={() => openFile(row)}>
                    Открыть файл
                  </Button>
                  <Button size="small" disabled={busy} onClick={() => choose(row)}>
                    Привязать
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Space>
      <EdoCompareDrawer
        open={compareOpen}
        deliveryId={deliveryId}
        candidate={compare?.candidate ?? null}
        photos={deliveryPhotos}
        onClose={() => setCompareOpen(false)}
        afterClose={() => {
          // Порядок важен: сначала фокус во внешнее окно, потом очистка данных.
          rootRef.current?.closest<HTMLElement>('.ant-modal-wrap')?.focus({ preventScroll: true });
          setCompare(null);
        }}
        onOpenXml={() => {
          if (compare?.candidate) void openXml(compare.candidate);
        }}
      />
    </Modal>
  );
}
