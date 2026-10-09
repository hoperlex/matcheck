import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography, message } from 'antd';
import { api } from '../../services/api';
import { formatMoneyRu } from '../../shared/utils/formatRu';

type Candidate = {
  id: string;
  source: 'import' | 'export';
  contentCategory: string | null;
  paperDocNumber: string | null;
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  totalSum: string | null;
  siteId: string | null;
  usedElsewhere: number;
  score: number;
  level: 'high' | 'possible' | 'weak';
  matches: string[];
  conflicts: string[];
  missing: string[];
};

type Response = { items: Candidate[]; referenceMissing: string[] };

export function LinkEdoDocumentModal({
  open,
  deliveryId,
  busy,
  error,
  onCancel,
  onPick,
}: {
  open: boolean;
  deliveryId: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onPick: (candidate: Candidate) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const candidates = useQuery({
    queryKey: ['delivery-edo-candidates', deliveryId, query],
    queryFn: () =>
      api.get<Response>(
        `/deliveries/${deliveryId}/edo-candidates${query ? `?q=${encodeURIComponent(query)}` : ''}`,
      ),
    enabled: open && !!deliveryId,
  });

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

  const openFile = async (candidate: Candidate) => {
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

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="Подобрать УПД из ЭДО"
      width="min(1200px, 96vw)"
      footer={null}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Кандидаты отсортированы по совпадению реквизитов и материалов. Выбор УПД подтвердит связь
          с приёмкой.
        </Typography.Text>
        {error && <Alert type="error" message={error} showIcon />}
        {candidates.isError && (
          <Alert type="error" message="Не удалось загрузить УПД из ЭДО" showIcon />
        )}
        {!!candidates.data?.referenceMissing.length && (
          <Alert
            type="warning"
            showIcon
            message={`Для точной сверки не хватает данных: ${candidates.data.referenceMissing.join(', ')}.`}
            description="Добавьте или исправьте бумажную УПД в разделе «Документы», если её реквизиты не распознаны."
          />
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
          rowKey="id"
          dataSource={candidates.data?.items ?? []}
          loading={candidates.isLoading || busy}
          size="small"
          scroll={{ x: 950, y: '50vh' }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{
            emptyText: query
              ? 'По запросу УПД не найдены'
              : 'Поблизости по дате УПД не найдены. Введите номер или поставщика.',
          }}
          columns={[
            {
              title: 'УПД',
              key: 'document',
              width: 155,
              render: (_value, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{row.docNumber ?? 'Без номера'}</Typography.Text>
                  <Typography.Text type="secondary">{row.docDate ?? 'Без даты'}</Typography.Text>
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
                  {row.paperDocNumber && (
                    <Typography.Text type="secondary">
                      С бумажной УПД № {row.paperDocNumber}
                    </Typography.Text>
                  )}
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
                  <Button size="small" type="link" onClick={() => void openFile(row)}>
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
    </Modal>
  );
}
