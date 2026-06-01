import { useMemo, useState } from 'react';
import { Alert, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  SourceDirection,
  SourceDocument,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';

type List = z.infer<typeof SourceDocumentListResponseSchema>;

/**
 * Модалка ручной привязки УПД к приёмке/отгрузке «Без документа».
 * Видна только admin/manager (фильтрация по роли — на стороне вызывающей формы).
 * Показывает только непривязанные УПД нужного направления; по умолчанию
 * фильтрует по siteId приёмки/отгрузки, но даёт переключатель «все объекты».
 */
export function LinkSourceDocumentModal({
  open,
  onCancel,
  onPick,
  direction,
  siteId,
  busy,
  error,
}: {
  open: boolean;
  onCancel: () => void;
  onPick: (upd: SourceDocument) => void;
  direction: SourceDirection;
  siteId: string | null;
  busy?: boolean;
  error?: string | null;
}) {
  const [allSites, setAllSites] = useState(false);

  const list = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', direction],
    queryFn: () => {
      const qs = new URLSearchParams({
        kind: 'upd,transport_waybill,os2_transfer',
        direction,
        unaccepted: 'true',
        limit: '200',
      });
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    enabled: open,
  });

  const items = list.data?.items ?? [];
  const filtered = useMemo(() => {
    if (allSites || !siteId) return items;
    // Если у приёмки есть siteId — показываем УПД того же объекта плюс УПД
    // без указанного объекта (siteId=null). Это покрывает случай, когда УПД
    // распознана без сайта, а диспетчер всё равно должен суметь её привязать.
    return items.filter((r) => r.siteId === siteId || r.siteId === null);
  }, [items, siteId, allSites]);

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="Привязать УПД"
      width={900}
      footer={null}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {error ? <Alert type="error" message={error} showIcon /> : null}
        {siteId ? (
          <Space>
            <Switch checked={allSites} onChange={setAllSites} disabled={busy} />
            <Typography.Text>Показать УПД всех объектов</Typography.Text>
          </Space>
        ) : null}
        <Table<SourceDocument>
          rowKey="id"
          dataSource={filtered}
          loading={list.isLoading || busy}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          onRow={(r) => ({
            onClick: () => {
              if (!busy) onPick(r);
            },
            style: { cursor: busy ? 'progress' : 'pointer' },
          })}
          locale={{
            emptyText: list.isLoading
              ? 'Загрузка…'
              : 'Нет свободных УПД для привязки',
          }}
          columns={[
            {
              title: 'Номер',
              dataIndex: 'docNumber',
              render: (v: string | null) => (
                <Tag color="blue">{v ?? '— без номера —'}</Tag>
              ),
            },
            {
              title: 'Дата',
              dataIndex: 'docDate',
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Поставщик',
              key: 'supplier',
              render: (_: unknown, r: SourceDocument) => r.supplierName ?? '—',
            },
            {
              title: 'Подрядчик',
              key: 'contractor',
              render: (_: unknown, r: SourceDocument) => r.contractorName ?? '—',
            },
            {
              title: 'Объект',
              key: 'site',
              render: (_: unknown, r: SourceDocument) => r.siteName ?? '—',
            },
            {
              title: 'Сумма',
              key: 'total',
              render: (_: unknown, r: SourceDocument) =>
                r.totalSum ? `${r.totalSum} ₽` : '—',
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
