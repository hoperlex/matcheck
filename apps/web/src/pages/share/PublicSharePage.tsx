import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Form,
  Image,
  Input,
  Layout,
  Result,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message as antdMessage,
} from 'antd';
import { EditOutlined, SendOutlined } from '@ant-design/icons';
import type {
  PublicShareMessageCreateResponse,
  PublicShareMessageListResponse,
  PublicSharedEntity,
  ShareMessage,
} from '@matcheck/contracts';
import { ApiError } from '../../services/api';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { formatDecimal } from '../../shared/utils/formatDecimal';

const SENDER_LS_KEY = 'matcheck.shareMsg.sender';
// SavedSender — раньше был {name, email}. После запроса убрать email из
// формы остался только name. Старые записи с {name, email} тоже читаются —
// в типе email опциональный, мы просто не используем его.
type SavedSender = { name: string };

function readSavedSender(): SavedSender | null {
  try {
    const raw = window.localStorage.getItem(SENDER_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ name: string }>;
    if (typeof parsed.name === 'string' && parsed.name.length > 0) {
      return { name: parsed.name };
    }
    return null;
  } catch {
    return null;
  }
}

function saveSavedSender(s: SavedSender): void {
  try {
    window.localStorage.setItem(SENDER_LS_KEY, JSON.stringify(s));
  } catch {
    /* private mode — ignore */
  }
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

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
  // Грубый mobile-флаг (< 768): на десктопе чат — sidebar 20% справа;
  // на мобильном — inline-блок на всю ширину снизу под Материалами.
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.innerWidth < 768,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
          // Двухколоночный layout: основной контент (≈ 80%) + sidebar
          // чата (≈ 20%, всегда открыт). На мобильном — стек, чат внизу.
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          gap: 16,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ flex: 1, minWidth: 0, width: isMobile ? '100%' : undefined }}>
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

          <Collapse
            // По умолчанию фото раскрыты. Клик по шапке сворачивает —
            // материалы тогда сразу видны без скролла.
            defaultActiveKey={['photos']}
            ghost
            style={{
              background: '#fff',
              border: '1px solid #f0f0f0',
              borderRadius: 6,
            }}
            items={[
              {
                key: 'photos',
                label: (
                  <Typography.Text strong>
                    Фото ({data.photos.length})
                  </Typography.Text>
                ),
                children:
                  data.photos.length === 0 ? (
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
                  ),
              },
            ]}
          />

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
                showSorterTooltip={false}
                // scroll={x:'max-content'} убран — давал горизонтальный
                // скролл на длинных названиях. Колонка «Наименование»
                // теперь ellipsis, влезает в ширину страницы (95vw).
              />
            )}
          </div>
        </Space>
        </div>
        {/* Sidebar с чатом — sticky на десктопе (всегда виден при скролле
            контента), inline на мобильном. Высота: на desktop — почти
            весь viewport (минус padding); на mobile — фиксированные 500px,
            чтобы не съесть весь экран. */}
        <aside
          style={{
            width: isMobile ? '100%' : '20%',
            minWidth: isMobile ? undefined : 280,
            flexShrink: 0,
            position: isMobile ? 'static' : 'sticky',
            top: 16,
            height: isMobile ? 500 : 'calc(100vh - 32px)',
          }}
        >
          <PublicShareChat token={token} />
        </aside>
      </Layout.Content>
    </Layout>
  );
}

/**
 * Sidebar-чат на публичной share-странице. Раньше был FAB-виджет
 * (свёрнутая круглая иконка → разворачиваемая панель). По запросу
 * пользователя теперь чат всегда открыт колонкой справа (≈ 20% ширины
 * страницы на desktop, inline-блок снизу на mobile). Никакой
 * иконки/expand/collapse нет.
 *
 * Логика отправки: первая отправка — поля Имя+Email (сохраняются в
 * localStorage); вторая и далее — только TextArea с ссылкой «изменить».
 * Polling списка сообщений: 2 сек (эффект мессенджера). Это та же
 * частота, что в раскрытом FAB-режиме раньше.
 */
function PublicShareChat({ token }: { token: string }): JSX.Element {
  const [savedSender, setSavedSender] = useState<SavedSender | null>(() => readSavedSender());
  const [editingSender, setEditingSender] = useState(false);
  const [body, setBody] = useState('');
  const [name, setName] = useState(savedSender?.name ?? '');
  const [messages, setMessages] = useState<ShareMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fetchMessages = useMemo(
    () => async () => {
      try {
        const r = await fetch(`/api/v1/share/${encodeURIComponent(token)}/messages`);
        if (r.status === 410) {
          setGone(true);
          return;
        }
        if (!r.ok) return;
        const json = (await r.json()) as PublicShareMessageListResponse;
        setMessages(json.items);
      } catch {
        /* ignore network blips */
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  // Polling 2 сек (раньше адаптивно 2/30 в зависимости от expanded;
  // теперь панель всегда открыта — фоновых режимов нет). Focus →
  // моментальный рефреш при возврате во вкладку.
  useEffect(() => {
    void fetchMessages();
    const id = window.setInterval(fetchMessages, 2_000);
    const onFocus = () => void fetchMessages();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchMessages]);

  // Автоскролл к низу при новом сообщении.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  if (gone) return <></>;

  const showFullForm = !savedSender || editingSender;

  const onSend = async () => {
    setError(null);
    if (!body.trim()) return;
    const payload = {
      senderName: (savedSender?.name ?? name).trim(),
      body: body.trim(),
    };
    setSending(true);
    try {
      const r = await fetch(`/api/v1/share/${encodeURIComponent(token)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 429) {
        setError('Слишком много сообщений. Подождите минуту и попробуйте снова.');
        return;
      }
      if (r.status === 410) {
        setGone(true);
        return;
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { message?: string } | null;
        setError(j?.message ?? 'Не удалось отправить сообщение.');
        return;
      }
      const json = (await r.json()) as PublicShareMessageCreateResponse;
      setMessages((prev) => [...prev, json.message]);
      setBody('');
      const sender: SavedSender = { name: payload.senderName };
      saveSavedSender(sender);
      setSavedSender(sender);
      setEditingSender(false);
      antdMessage.success('Сообщение отправлено');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Сетевая ошибка');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#fff',
        border: '1px solid #f0f0f0',
        borderRadius: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Шапка панели */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          padding: '10px 12px',
          background: '#1677ff',
          color: '#fff',
        }}
      >
        <Typography.Text strong style={{ color: '#fff', fontSize: 15 }}>
          Связаться с менеджером
        </Typography.Text>
      </div>

      {/* История сообщений — скроллер. */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 120,
          overflowY: 'auto',
          padding: 12,
          background: '#fafafa',
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 16 }}>
            <Spin size="small" />
          </div>
        ) : messages.length === 0 ? (
          <Typography.Text
            type="secondary"
            style={{ display: 'block', textAlign: 'center', padding: '12px 0', fontSize: 12 }}
          >
            Менеджер увидит ваш вопрос и ответит здесь же. Обновите страницу
            через пару минут, чтобы увидеть ответ.
          </Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {messages.map((m) => (
              <PublicBubble key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>

      {/* Форма отправки */}
      <div style={{ padding: 10, borderTop: '1px solid #f0f0f0', background: '#fff' }}>
        {showFullForm ? (
          <Form layout="vertical" disabled={sending} style={{ marginBottom: 6 }}>
            <Form.Item style={{ marginBottom: 6 }} required>
              <Input
                placeholder="Ваше имя"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                size="small"
              />
            </Form.Item>
          </Form>
        ) : (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', marginBottom: 4 }}
          >
            Отправляете как: <b>{savedSender?.name}</b>{' '}
            <a
              onClick={(e) => {
                e.preventDefault();
                setEditingSender(true);
              }}
              style={{ marginLeft: 4 }}
            >
              <EditOutlined /> изменить
            </a>
          </Typography.Text>
        )}

        <Input.TextArea
          placeholder="Сообщение менеджеру… (Enter — отправить, Shift+Enter — перенос строки)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          // Enter без Shift отправляет сообщение, Shift+Enter — перенос
          // строки. Привычный мессенджерный UX, чтобы не дёргать кнопку
          // мышью каждый раз.
          onPressEnter={(e) => {
            if (e.shiftKey) return;
            e.preventDefault();
            const disabled =
              !body.trim() || (showFullForm && !name.trim()) || sending;
            if (!disabled) void onSend();
          }}
          autoSize={{ minRows: 2, maxRows: 5 }}
          maxLength={4000}
          disabled={sending}
          style={{ marginBottom: 6 }}
        />
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 6 }}
            closable
            onClose={() => setError(null)}
          />
        )}
        <div style={{ textAlign: 'right' }}>
          <Button
            type="primary"
            size="small"
            icon={<SendOutlined />}
            loading={sending}
            disabled={!body.trim() || (showFullForm && !name.trim())}
            onClick={onSend}
          >
            Отправить
          </Button>
        </div>
      </div>
    </div>
  );
}

function PublicBubble({ m }: { m: ShareMessage }) {
  // На публичной странице «я» — это external (получатель ссылки), его
  // сообщения справа в синем; менеджер — слева в сером. Симметрично
  // менеджерскому Drawer'у, но «я» с другой стороны.
  const isExternal = m.senderType === 'external';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isExternal ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          background: isExternal ? '#e6f4ff' : '#fafafa',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: '6px 10px',
        }}
      >
        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#8c8c8c' }}>
          <span style={{ fontWeight: 600 }}>
            {m.senderName ?? (isExternal ? 'Вы' : 'Менеджер')}
          </span>
          <span>{formatRelativeTime(m.createdAt)}</span>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>
          {m.body}
        </div>
      </div>
    </div>
  );
}
