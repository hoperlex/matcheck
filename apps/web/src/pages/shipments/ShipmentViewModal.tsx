import { Button, Collapse, Empty, Modal, Space, Table, Tag, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { z } from 'zod';
import type { ShipmentListResponseSchema, ShipmentKind } from '@matcheck/contracts';
import { PhotoGallery } from '../kpp/PhotoGallery';
import { formatStageTime } from '../kpp/stageTime';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';

type Row = z.infer<typeof ShipmentListResponseSchema>['items'][number];
type Item = Row['items'][number];

export type ShipmentViewData = {
  shipment: Row;
  receiverName: string | null;
  siteName: string | null;
  destSiteName: string | null;
  docNumber: string | null;
  docKindLabel: string | null;
  docTotalSum: number | null;
};

// Палитра тегов «Вид» совпадает с MaterialsPage/ShipmentsHistory для
// визуальной консистентности раздела.
const KIND_LABELS: Record<ShipmentKind, { label: string; color: string }> = {
  contractor: { label: 'Подрядчику', color: 'geekblue' },
  return: { label: 'Возврат', color: 'magenta' },
  transfer: { label: 'Перемещение', color: 'cyan' },
  writeoff: { label: 'Списание', color: 'volcano' },
};

/**
 * Read-only модалка просмотра отгрузки (кнопка 👁 в строке). Зеркало
 * DeliveryViewModal — UX симметричный: те же чипы шапки, Collapse «Фото»
 * с разделением «1 Этап / 2 Этап» (поле stage у shipment_photos
 * введено миграцией 0048), таблица материалов без горизонтального скролла.
 */
export function ShipmentViewModal({
  data,
  open,
  onClose,
  onEdit,
}: {
  data: ShipmentViewData | null;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const s = data?.shipment;
  const items = s?.items ?? [];

  const itemColumns = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    {
      title: 'Название',
      dataIndex: 'nameRaw',
      ellipsis: { showTitle: true } as const,
    },
    {
      title: 'План',
      dataIndex: 'qtyPlanned',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    {
      title: 'Факт',
      dataIndex: 'qtyActual',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    { title: 'Ед.', dataIndex: 'unit', width: 60 },
    {
      title: 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      key: 'rowTotal',
      width: 140,
      render: (_: unknown, r: Item) => {
        const qtyRaw = r.qtyActual ?? r.qtyPlanned;
        const qty = qtyRaw !== null && qtyRaw !== '' ? Number(qtyRaw) : null;
        const price = r.price !== null && r.price !== '' ? Number(r.price) : null;
        if (qty === null || price === null || !Number.isFinite(qty) || !Number.isFinite(price))
          return formatMoneyRu(null);
        return formatMoneyRu(qty * price);
      },
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width="97vw"
      style={{ top: 4, paddingBottom: 0 }}
      title={
        s && data ? (
          <Space size={4} wrap style={{ fontSize: 12 }}>
            <Tag style={{ marginInlineEnd: 0 }} color={s.status.color ?? 'default'}>
              {s.status.label}
            </Tag>
            <Tag color={KIND_LABELS[s.kind].color} style={{ marginInlineEnd: 0 }}>
              {KIND_LABELS[s.kind].label}
            </Tag>
            {s.sourceDocumentIds.length === 0 && (
              <Tag style={{ marginInlineEnd: 0 }} color="gold">
                Без документа
              </Tag>
            )}
            {data.docKindLabel ? (
              <Tag style={{ marginInlineEnd: 0 }} color="blue">
                {data.docKindLabel}
                {data.docNumber ? ` №${data.docNumber}` : ''}
              </Tag>
            ) : null}
            {data.siteName ? (
              <Tag style={{ marginInlineEnd: 0 }}>Объект: {data.siteName}</Tag>
            ) : null}
            {data.receiverName ? (
              <Tag style={{ marginInlineEnd: 0 }}>Получатель: {data.receiverName}</Tag>
            ) : null}
            {data.destSiteName ? (
              <Tag style={{ marginInlineEnd: 0 }}>На объект: {data.destSiteName}</Tag>
            ) : null}
            {s.vehiclePlate ? (
              <Tag style={{ marginInlineEnd: 0 }}>Авто: {s.vehiclePlate}</Tag>
            ) : null}
            {s.purpose ? (
              <Tag style={{ marginInlineEnd: 0 }} color="cyan">
                Тип отгрузки: {s.purpose}
              </Tag>
            ) : null}
            {s.inTransit ? (
              <Tag style={{ marginInlineEnd: 0 }} color="orange">
                🚚 Транзит
              </Tag>
            ) : null}
            {s.isAssets ? (
              <Tag style={{ marginInlineEnd: 0 }} color="purple">
                📦 ОС
              </Tag>
            ) : null}
            {data.docTotalSum != null ? (
              <Tag style={{ marginInlineEnd: 0 }}>
                Сумма: {formatMoneyRu(data.docTotalSum)}
              </Tag>
            ) : null}
            <PendingDeletionTag
              at={s.pendingDeletionAt}
              byEmail={s.pendingDeletionByUserEmail}
              reason={s.pendingDeletionReason}
            />
          </Space>
        ) : (
          'Просмотр отгрузки'
        )
      }
      styles={{
        header: { padding: '8px 16px' },
        body: {
          padding: '12px 16px',
          maxHeight: 'calc(97vh - 120px)',
          overflow: 'auto',
        },
        footer: { padding: '8px 16px' },
        // См. комментарий в DeliveryViewModal: убираем «вспышку таблицы»
        // при закрытии через мгновенное скрытие маски и обёртки.
        mask: { transitionDuration: '0s' },
        wrapper: { transitionDuration: '0s' },
      }}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={onEdit}>
            Открыть в редакторе
          </Button>
        </Space>
      }
      destroyOnClose
      transitionName=""
    >
      {s ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text>
              <b>Отгрузка:</b>{' '}
              {s.shippedAt
                ? `${formatDateRu(s.shippedAt)} ${new Date(s.shippedAt)
                    .toTimeString()
                    .slice(0, 5)}`
                : '—'}
            </Typography.Text>
            {s.driverName ? (
              <Typography.Text>
                <b>Водитель:</b> {s.driverName}
              </Typography.Text>
            ) : null}
            {s.confirmedByMolAt ? (
              <Typography.Text>
                <b>Подтверждение МОЛ:</b>{' '}
                {`${formatDateRu(s.confirmedByMolAt)} ${new Date(s.confirmedByMolAt)
                  .toTimeString()
                  .slice(0, 5)}`}
                {s.confirmedByMolUserEmail ? ` (${s.confirmedByMolUserEmail})` : ''}
              </Typography.Text>
            ) : null}
          </Space>

          {(() => {
            const beforePhotos = s.photos.filter((p) => p.stage !== 'after');
            const afterPhotos = s.photos.filter((p) => p.stage === 'after');
            return (
              <Collapse
                defaultActiveKey={['photos']}
                ghost
                size="small"
                items={[
                  {
                    key: 'photos',
                    label: (
                      <Typography.Text strong>Фото ({s.photos.length})</Typography.Text>
                    ),
                    children:
                      s.photos.length === 0 ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="Нет фото"
                          style={{ margin: '12px 0' }}
                        />
                      ) : (
                        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                          <div>
                            <Typography.Text strong>
                              1 Этап{' '}
                              {beforePhotos.length > 0 && `(${beforePhotos.length})`}
                            </Typography.Text>
                            {(() => {
                              const t = formatStageTime(beforePhotos);
                              return t ? (
                                <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                                  Время: {t}
                                </Typography.Text>
                              ) : null;
                            })()}
                            <div style={{ marginTop: 8 }}>
                              {beforePhotos.length > 0 ? (
                                <PhotoGallery
                                  deliveryId={s.id}
                                  photos={beforePhotos}
                                  operationKind="shipment"
                                />
                              ) : (
                                <Typography.Text type="secondary">
                                  Фото 1-го этапа ещё нет.
                                </Typography.Text>
                              )}
                            </div>
                          </div>
                          <div>
                            <Typography.Text strong>
                              2 Этап{' '}
                              {afterPhotos.length > 0 && `(${afterPhotos.length})`}
                            </Typography.Text>
                            {(() => {
                              const t = formatStageTime(afterPhotos);
                              return t ? (
                                <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                                  Время: {t}
                                </Typography.Text>
                              ) : null;
                            })()}
                            <div style={{ marginTop: 8 }}>
                              {afterPhotos.length > 0 ? (
                                <PhotoGallery
                                  deliveryId={s.id}
                                  photos={afterPhotos}
                                  operationKind="shipment"
                                />
                              ) : (
                                <Typography.Text type="secondary">
                                  {s.status.code === 'confirmed_mol'
                                    ? 'Фото 2-го этапа ещё нет.'
                                    : 'МОЛ ещё не подтвердил отгрузку.'}
                                </Typography.Text>
                              )}
                            </div>
                          </div>
                        </Space>
                      ),
                  },
                ]}
              />
            );
          })()}

          <div>
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
              Материалы ({items.length})
            </Typography.Title>
            {items.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Нет материалов"
                style={{ margin: '12px 0' }}
              />
            ) : (
              <Table<Item>
                dataSource={items}
                rowKey="id"
                size="small"
                pagination={false}
                columns={itemColumns}
                showSorterTooltip={false}
              />
            )}
          </div>
        </Space>
      ) : null}
    </Modal>
  );
}
