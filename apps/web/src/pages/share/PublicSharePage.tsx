import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Empty,
  Image,
  Layout,
  Result,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { PublicSharedEntity } from '@matcheck/contracts';
import { ApiError } from '../../services/api';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { formatDecimal } from '../../shared/utils/formatDecimal';

/**
 * Публичная страница просмотра приёмки/отгрузки по share-токену.
 * Без авторизации (вне ProtectedRoute). Минималистичный layout без
 * сайдбара/шапки портала — внешний получатель видит только содержимое.
 *
 * Фото загружаются через proxy-endpoint /api/v1/share/{token}/photos/{id},
 * сервер сам идёт в S3 — клиент не видит S3-URL.
 */
export default function PublicSharePage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const [data, setData] = useState<PublicSharedEntity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Не используем общий api-helper: он добавляет Bearer-токен и
    // делает retry через refresh — для публичного endpoint всё это не
    // нужно и может дать ложные ошибки.
    fetch(`/api/v1/share/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 410) {
          setError('Срок действия ссылки истёк или она была отозвана.');
          setLoading(false);
          return;
        }
        if (r.status === 404) {
          setError('Ссылка не найдена.');
          setLoading(false);
          return;
        }
        if (!r.ok) {
          setError('Не удалось загрузить данные.');
          setLoading(false);
          return;
        }
        const json = (await r.json()) as PublicSharedEntity;
        if (cancelled) return;
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Сетевая ошибка');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#fafafa' }}>
        <Layout.Content
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin size="large" />
        </Layout.Content>
      </Layout>
    );
  }

  if (error || !data) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#fafafa' }}>
        <Layout.Content style={{ padding: 24 }}>
          <Result
            status="warning"
            title="Ссылка недоступна"
            subTitle={error ?? 'Неизвестная ошибка'}
          />
        </Layout.Content>
      </Layout>
    );
  }

  const isDelivery = data.entityType === 'delivery';
  const itemColumns = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    {
      title: 'Наименование',
      dataIndex: 'nameRaw',
      // ellipsis с native-title — длинное название не растягивает таблицу
      // в ширину (вместе с убранным scroll={{x:'max-content'}} это убирает
      // горизонтальный скролл у материалов).
      ellipsis: { showTitle: true } as const,
    },
    {
      title: isDelivery ? 'План' : 'Кол-во',
      dataIndex: 'qtyPlanned',
      width: 100,
      render: (v: string | null) => formatDecimal(v),
    },
    ...(isDelivery
      ? [
          {
            title: 'Факт',
            dataIndex: 'qtyActual',
            width: 100,
            render: (v: string | null) => formatDecimal(v),
          },
        ]
      : []),
    { title: 'Ед.', dataIndex: 'unit', width: 70 },
    {
      title: 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      width: 140,
      render: (v: string | null) => formatMoneyRu(v),
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh', background: '#fafafa' }}>
      <Layout.Content
        style={{
          padding: 16,
          maxWidth: '95vw',
          margin: '0 auto',
          width: '100%',
        }}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {isDelivery ? 'Приёмка' : 'Отгрузка'} (просмотр)
          </Typography.Title>

          <Alert
            type="info"
            showIcon
            message="Это публичная ссылка только для просмотра. Срок действия истекает позже."
            description={`Ссылка действует до: ${formatDateRu(data.shareExpiresAt)}`}
          />

          <div
            style={{
              padding: 16,
              background: '#fff',
              border: '1px solid #f0f0f0',
              borderRadius: 6,
            }}
          >
            <Space size={6} wrap style={{ fontSize: 13 }}>
              <Tag color={data.status.code === 'confirmed_mol' ? 'blue' : 'green'}>
                {data.status.label}
              </Tag>
              {data.siteName ? <Tag>Объект: {data.siteName}</Tag> : null}
              {data.supplierName ? <Tag>Поставщик: {data.supplierName}</Tag> : null}
              {data.contractorName ? <Tag>Подрядчик: {data.contractorName}</Tag> : null}
              {data.recipientMolName ? <Tag>МОЛ: {data.recipientMolName}</Tag> : null}
              {data.vehiclePlate ? <Tag>Авто: {data.vehiclePlate}</Tag> : null}
              {data.driverName ? <Tag>Водитель: {data.driverName}</Tag> : null}
              {'docNumber' in data && data.docNumber ? (
                <Tag color="blue">УПД №{data.docNumber}</Tag>
              ) : null}
              {'docDate' in data && data.docDate ? (
                <Tag>Дата документа: {formatDateRu(data.docDate)}</Tag>
              ) : null}
              {'expectedDate' in data && data.expectedDate ? (
                <Tag>Дата поставки: {formatDateRu(data.expectedDate)}</Tag>
              ) : null}
              {'arrivedAt' in data && data.arrivedAt ? (
                <Tag>Прибытие: {formatDateRu(data.arrivedAt)}</Tag>
              ) : null}
              {'shippedAt' in data && data.shippedAt ? (
                <Tag>Отгружено: {formatDateRu(data.shippedAt)}</Tag>
              ) : null}
            </Space>
            {data.comment ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                {data.comment}
              </Typography.Paragraph>
            ) : null}
          </div>

          <div
            style={{
              padding: 16,
              background: '#fff',
              border: '1px solid #f0f0f0',
              borderRadius: 6,
            }}
          >
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
              Фото ({data.photos.length})
            </Typography.Title>
            {data.photos.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Фото нет" />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, 160px)',
                  gap: 8,
                }}
              >
                <Image.PreviewGroup>
                  {data.photos.map((p) => (
                    <Image
                      key={p.id}
                      // src и preview указывают на один полноразмерный URL.
                      // Раньше src был p.thumbUrl, но если PUT thumb в S3
                      // упал тихо (см. photoPipeline:thumb-catch), сервер
                      // возвращает 502 и миниатюра рендерится пустой.
                      // Полный URL гарантированно есть — браузер кэширует,
                      // антд PreviewGroup переиспользует тот же ресурс.
                      src={p.url}
                      width={160}
                      height={160}
                      style={{ objectFit: 'cover', borderRadius: 6 }}
                      // Fallback на случай если сервер вернул 502/404 для
                      // несуществующего объекта — серый квадрат вместо
                      // «broken image».
                      fallback="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIGZpbGw9IiNmNWY1ZjUiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzhjOGM4YyIgZm9udC1zaXplPSIxMCI+0L3QtdGCINGE0L7RgtC+PC90ZXh0Pjwvc3ZnPg=="
                    />
                  ))}
                </Image.PreviewGroup>
              </div>
            )}
          </div>

          <div
            style={{
              padding: 16,
              background: '#fff',
              border: '1px solid #f0f0f0',
              borderRadius: 6,
            }}
          >
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
              Материалы ({data.items.length})
            </Typography.Title>
            {data.items.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Материалов нет" />
            ) : (
              <Table
                dataSource={data.items.map((it) => ({ ...it, key: it.lineNo }))}
                columns={itemColumns}
                size="small"
                pagination={false}
                // scroll={x:'max-content'} убран — давал горизонтальный
                // скролл на длинных названиях. Колонка «Наименование»
                // теперь ellipsis, влезает в ширину страницы (95vw).
              />
            )}
          </div>
        </Space>
      </Layout.Content>
    </Layout>
  );
}
