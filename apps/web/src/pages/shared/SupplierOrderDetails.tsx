import { Link } from 'react-router-dom';
import { Alert, Button, Descriptions, Space, Table, Tag, Typography } from 'antd';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  EstimatOrderItem,
  EstimatOrderItemsResponse,
  SupplierOrderCandidateDetail,
} from '@matcheck/contracts';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { APPROVAL_STATE_COLORS, approvalText, formatMsk, stageLabel } from '../../shared/utils/estimatOrder';

type ItemsQuery = Pick<UseQueryResult<EstimatOrderItemsResponse>, 'data' | 'isLoading' | 'isError' | 'refetch'>;

/**
 * Состав заказа. Пустой заказ, выключенная интеграция и молчащий EstiMat — три
 * разных ответа, и человек должен видеть, какой из них: только «нет позиций»
 * значит, что смотреть нечего.
 */
export function SupplierOrderItems({ items }: { items: ItemsQuery }) {
  const retry = (
    <Button size="small" onClick={() => void items.refetch()}>
      Повторить
    </Button>
  );
  if (items.isError) {
    return <Alert type="warning" showIcon message="Состав не загрузился" action={retry} />;
  }
  const data = items.data;
  if (data?.state === 'disabled') {
    return (
      <Typography.Text type="secondary">
        Состав недоступен: интеграция с EstiMat не настроена{data.message ? ` (${data.message})` : ''}.
      </Typography.Text>
    );
  }
  if (data?.state === 'unavailable') {
    return (
      <Alert
        type="info"
        showIcon
        message={`EstiMat сейчас не ответил${data.message ? `: ${data.message}` : ''}. Попробуйте позже.`}
        action={retry}
      />
    );
  }
  if (data && data.items.length === 0) {
    return <Typography.Text type="secondary">В заказе нет позиций.</Typography.Text>;
  }
  // Подпись — всегда соседка таблицы: antd сдвигает таблицу-«единственного
  // ребёнка» внутри строки другой таблицы (стиль вложенных таблиц), и в
  // раскрытой строке окна подбора состав уезжал вправо за край.
  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
        {data?.fetchedAt ? `Состав на ${formatMsk(data.fetchedAt)} (МСК)` : 'Состав загружается…'}
      </Typography.Text>
      <Table<EstimatOrderItem>
        rowKey="id"
        size="small"
        loading={items.isLoading}
        dataSource={data?.items ?? []}
        pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
        scroll={{ x: 760 }}
        columns={[
          { title: 'Материал', dataIndex: 'materialName', ellipsis: { showTitle: true } },
          { title: 'Ед.', dataIndex: 'unit', width: 70 },
          {
            title: 'Кол-во',
            dataIndex: 'quantity',
            width: 110,
            align: 'right',
            render: (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(v),
          },
          {
            title: 'Дата поставки',
            dataIndex: 'deliveryDate',
            width: 130,
            render: (v: string | null) => (v ? formatMsk(v, false) : '—'),
          },
          { title: 'Подрядчик', dataIndex: 'contractorName', width: 200, ellipsis: true, render: (v) => v ?? '—' },
        ]}
      />
    </div>
  );
}

/**
 * Подробности заказа EstiMat: поля, приёмки, к которым он привязан, и состав.
 * Общие для карточки во вкладке «Заказы» и раскрытой строки окна подбора;
 * журнал вкладка выводит сама — в подборе его нет.
 */
export function SupplierOrderDetails({
  order,
  items,
  descriptionColumns = 1,
  deliveryLinkTarget,
}: {
  order: SupplierOrderCandidateDetail;
  items: ItemsQuery;
  descriptionColumns?: 1 | 2;
  /** `_blank` — из окна поверх приёмки: переход сменил бы приёмку под окном. */
  deliveryLinkTarget?: '_blank';
}) {
  const o = order;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions
        size="small"
        column={descriptionColumns}
        bordered
        styles={{ label: { width: 150, whiteSpace: 'nowrap' } }}
      >
        <Descriptions.Item label="Стадия">
          <Tag color={APPROVAL_STATE_COLORS[o.approvalState]}>{stageLabel(o.sourcingStatus)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Виза">{approvalText(o)}</Descriptions.Item>
        <Descriptions.Item label="Объект">
          {o.siteCode ?? `EstiMat: ${o.projectCode ?? '—'} — не найден в портале`}
          {o.projectName ? ` · ${o.projectName}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="Сумма">
          <span style={{ whiteSpace: 'nowrap' }}>{formatMoneyRu(o.amount)}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Поставщик" span="filled">
          {o.supplierName ?? '— не выбран —'}
          {o.supplierInn ? `, ИНН ${o.supplierInn}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="Подрядчик" span="filled">
          {o.contractors.length === 0
            ? '—'
            : o.contractors.map((c) => (
                <div key={c.id}>
                  {c.name}
                  {c.type === 'mol' ? ' (МОЛ)' : ''}
                  {c.inn ? `, ИНН ${c.inn}` : ''}
                </div>
              ))}
        </Descriptions.Item>
        {o.contractNumber && (
          <Descriptions.Item label="Договор">
            {o.contractNumber}
            {o.contractDate ? ` от ${o.contractDate}` : ''}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Обновлено из EstiMat">{formatMsk(o.lastSeenAt)}</Descriptions.Item>
      </Descriptions>
      <div>
        <Typography.Title level={5}>Приёмки</Typography.Title>
        {o.deliveries.length === 0 ? (
          <Typography.Text type="secondary">Не привязан ни к одной приёмке</Typography.Text>
        ) : (
          <Space direction="vertical" size={2}>
            {o.deliveries.map((d) => (
              <Space key={d.deliveryId} size={6} wrap>
                <Link
                  to={`/operations?type=delivery&delivery=${d.deliveryId}`}
                  target={deliveryLinkTarget}
                  rel={deliveryLinkTarget ? 'noopener noreferrer' : undefined}
                >
                  Приёмка {d.displayId ?? '—'}
                </Link>
                <Typography.Text type="secondary">
                  {d.siteCode ?? '—'} · {formatMsk(d.arrivedAt)}
                </Typography.Text>
                {d.pendingDeletion && <Tag>помечена на удаление</Tag>}
                {d.siteMismatch && <Tag color="orange">другой объект</Tag>}
              </Space>
            ))}
          </Space>
        )}
      </div>
      <div>
        <Typography.Title level={5}>Состав</Typography.Title>
        <SupplierOrderItems items={items} />
      </div>
    </Space>
  );
}
