import { Button, Collapse, Empty, Modal, Space, Table, Tag, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { z } from 'zod';
import type { DeliveryListResponseSchema } from '@matcheck/contracts';
import { PhotoGallery } from './PhotoGallery';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';

type Row = z.infer<typeof DeliveryListResponseSchema>['items'][number];
type Item = Row['items'][number];

export type DeliveryViewData = {
  delivery: Row;
  contractorName: string | null;
  supplierName: string | null;
  siteName: string | null;
  docNumber: string | null;
  docKindLabel: string | null;
  docTotalSum: number | null;
};

/**
 * Read-only модалка просмотра приёмки (кнопка 👁 в строке). Раньше была
 * Drawer'ом — переехала на Modal для визуального единообразия с
 * edit-режимом (этап 2.А): оба окна выглядят одинаково.
 */
export function DeliveryViewModal({
  data,
  open,
  onClose,
  onEdit,
}: {
  data: DeliveryViewData | null;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const d = data?.delivery;
  const before = (d?.photos ?? []).filter((p) => p.stage === 'before');
  const after = (d?.photos ?? []).filter((p) => p.stage === 'after');
  const items = d?.items ?? [];

  // Колонки read-only таблицы материалов. План/Факт — десятичные количества
  // (formatDecimal сохраняет запятую и трейлинг-нули как в БД); Цена/НДС/Сумма —
  // деньги в русском формате (formatMoneyRu даёт «1 234,56 ₽»).
  const itemColumns = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    {
      title: 'Название',
      dataIndex: 'nameRaw',
      // ellipsis с native-title — длинное название не растягивает таблицу
      // в ширину (модалка 97vw, но позиции с описанием на абзац легко
      // выходят за рамки). Полный текст видно при hover.
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
        // Σ = qtyActual (или qtyPlanned, если факта нет) × price.
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
        d && data ? (
          <Space size={4} wrap style={{ fontSize: 12 }}>
            <Tag style={{ marginInlineEnd: 0 }} color={d.status.color ?? 'default'}>
              {d.status.label}
            </Tag>
            {d.sourceDocumentIds.length === 0 && (
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
            {data.contractorName ? (
              <Tag style={{ marginInlineEnd: 0 }}>Подрядчик: {data.contractorName}</Tag>
            ) : null}
            {data.supplierName ? (
              <Tag style={{ marginInlineEnd: 0 }}>Поставщик: {data.supplierName}</Tag>
            ) : null}
            {d.vehiclePlate ? (
              <Tag style={{ marginInlineEnd: 0 }}>Авто: {d.vehiclePlate}</Tag>
            ) : null}
            {data.docTotalSum != null ? (
              <Tag style={{ marginInlineEnd: 0 }}>
                Сумма: {formatMoneyRu(data.docTotalSum)}
              </Tag>
            ) : null}
            {d.inTransit ? (
              <Tag style={{ marginInlineEnd: 0 }} color="orange">
                🚚 Транзит
              </Tag>
            ) : null}
            <PendingDeletionTag
              at={d.pendingDeletionAt}
              byEmail={d.pendingDeletionByUserEmail}
              reason={d.pendingDeletionReason}
            />
          </Space>
        ) : (
          'Просмотр приёмки'
        )
      }
      styles={{
        header: { padding: '8px 16px' },
        // Body фикс-высоты — footer с «Закрыть/Открыть в редакторе»
        // всегда виден без скролла страницы. Внутри body — собственный
        // скролл, под содержимое.
        body: {
          padding: '12px 16px',
          maxHeight: 'calc(97vh - 120px)',
          overflow: 'auto',
        },
        footer: { padding: '8px 16px' },
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
      // Маска и контент модалки fade-out'ятся параллельно за ~200мс.
      // В середине transition сквозь полупрозрачную маску виден контент
      // OperationsPage под модалкой — пользователь воспринимает это как
      // «вспышку таблицы перед закрытием». Отключаем mask-transition —
      // маска исчезает мгновенно вместе с контентом. Применено симметрично
      // в ShipmentViewModal и SourceDocumentDetailModal.
      maskTransitionName=""
    >
      {d ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text>
              <b>Прибытие:</b>{' '}
              {d.arrivedAt
                ? `${formatDateRu(d.arrivedAt)} ${new Date(d.arrivedAt)
                    .toTimeString()
                    .slice(0, 5)}`
                : '—'}
            </Typography.Text>
            {d.driverName ? (
              <Typography.Text>
                <b>Водитель:</b> {d.driverName}
              </Typography.Text>
            ) : null}
            {d.confirmedByMolAt ? (
              <Typography.Text>
                <b>Подтверждение МОЛ:</b>{' '}
                {`${formatDateRu(d.confirmedByMolAt)} ${new Date(d.confirmedByMolAt)
                  .toTimeString()
                  .slice(0, 5)}`}
                {d.confirmedByMolUserEmail ? ` (${d.confirmedByMolUserEmail})` : ''}
              </Typography.Text>
            ) : null}
          </Space>

          <Collapse
            // По умолчанию фото раскрыты — основной контент просмотра.
            // Если у приёмки много материалов с длинными названиями,
            // пользователь сворачивает фото одним кликом, чтобы быстрее
            // листать таблицу.
            defaultActiveKey={['photos']}
            ghost
            size="small"
            items={[
              {
                key: 'photos',
                label: (
                  <Typography.Text strong>
                    Фото ({d.photos.length})
                  </Typography.Text>
                ),
                children: d.photos.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="Нет фото"
                    style={{ margin: '12px 0' }}
                  />
                ) : (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    {before.length > 0 && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          1 Этап ({before.length})
                        </Typography.Text>
                        <div style={{ marginTop: 4 }}>
                          <PhotoGallery
                            deliveryId={d.id}
                            photos={before}
                            operationKind="delivery"
                          />
                        </div>
                      </div>
                    )}
                    {after.length > 0 && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          2 Этап ({after.length})
                        </Typography.Text>
                        <div style={{ marginTop: 4 }}>
                          <PhotoGallery
                            deliveryId={d.id}
                            photos={after}
                            operationKind="delivery"
                          />
                        </div>
                      </div>
                    )}
                  </Space>
                ),
              },
            ]}
          />

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
                // scroll={x:'max-content'} убран — заставлял таблицу
                // растягиваться по самому длинному названию и плодил
                // горизонтальный скролл даже на широкой 97vw-модалке.
                // Колонка «Название» теперь ellipsis: гибко влезает в
                // оставшуюся ширину, длинное название обрезается с title.
              />
            )}
          </div>
        </Space>
      ) : null}
    </Modal>
  );
}
