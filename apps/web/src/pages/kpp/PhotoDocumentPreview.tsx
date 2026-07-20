import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Spin, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhotoRecognition, PhotoRecognitionItem } from '@matcheck/contracts';
import { api, apiDownload, ApiError } from '../../services/api';
import { enqueueFullLoad } from '../../lib/thumbQueue';

/**
 * Split-view модалка просмотра фото-документа: слева увеличенное фото,
 * справа таблица распознанных позиций. Открывается из PhotoGallery
 * при клике на превью с kind='document'. Для kind='cargo'/'vehicle'
 * показывается стандартный antd Image preview как раньше.
 *
 * Логика данных:
 *   1) GET /photos/:id/recognition — пробуем взять кэш.
 *   2) Если нет (404) — автоматически POST /photos/:id/recognize.
 *   3) Пока ждём (10-30 сек) — рисуем Spin «Распознаём…».
 *   4) Готово/упало — рисуем таблицу или error с retry.
 */
export function PhotoDocumentPreview({
  open,
  onClose,
  photoId,
  imageSrc,
}: {
  open: boolean;
  onClose: () => void;
  photoId: string;
  imageSrc: string;
}): JSX.Element {
  const qc = useQueryClient();

  // Оригинал документа. imageSrc, переданный из PhotoGallery, — это миниатюра
  // (320px): фото-документ открывается по клику при previewOpen=false, поэтому
  // fullQuery галереи не стартовал, и текст скана на миниатюре нечитаем. Грузим
  // оригинал сами по photoId. Тот же query-ключ, что у PhotoThumb.fullQuery →
  // react-query переиспользует кэш в обе стороны; та же очередь-лимитер.
  const fullBlob = useQuery({
    queryKey: ['photo-blob', photoId, 'full'],
    queryFn: () =>
      enqueueFullLoad(async () => {
        const { blob } = await apiDownload(`/photos/${photoId}/content`);
        return blob;
      }),
    enabled: open,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    refetchOnWindowFocus: false,
  });
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!fullBlob.data) {
      setFullUrl(null);
      return;
    }
    const url = URL.createObjectURL(fullBlob.data);
    setFullUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [fullBlob.data]);
  // Оригинал когда загружен, иначе переданная миниатюра как быстрый плейсхолдер.
  const displaySrc = fullUrl ?? imageSrc;

  const recognition = useQuery<PhotoRecognition | null>({
    queryKey: ['photo-recognition', photoId],
    queryFn: async () => {
      try {
        return await api.get<PhotoRecognition>(`/photos/${photoId}/recognition`);
      } catch (err) {
        // 404 — кэша нет, нужно вызвать /recognize. Не считаем ошибкой.
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: open,
    staleTime: 60 * 1000,
  });

  const recognize = useMutation<PhotoRecognition, Error, { force?: boolean }>({
    mutationFn: ({ force }) =>
      api.post<PhotoRecognition>(
        `/photos/${photoId}/recognize${force ? '?force=true' : ''}`,
        {},
        {
          // Распознавание синхронно ждёт LLM (серверный бюджет 600с) — свой
          // таймаут выше дефолтных 20с, иначе штатная операция оборвётся.
          timeoutMs: 610_000,
        },
      ),
    onSuccess: (data) => {
      qc.setQueryData<PhotoRecognition>(['photo-recognition', photoId], data);
    },
    onError: (err) => {
      message.error(err instanceof ApiError ? err.message : 'Распознавание не удалось');
    },
  });

  // Автозапуск распознавания при первом открытии модалки, если кэша нет.
  useEffect(() => {
    if (!open) return;
    if (recognition.isLoading) return;
    if (recognition.data) return;
    if (recognize.isPending) return;
    recognize.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recognition.isLoading, recognition.data]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="97vw"
      style={{ top: 24 }}
      bodyStyle={{
        padding: 0,
        height: 'calc(100vh - 80px)',
        display: 'flex',
        overflow: 'hidden',
      }}
      destroyOnClose
    >
      {/* Слева: фото с zoom через background-image + scroll. Используем
          стандартный <img> а не antd Image, чтобы лишний preview-оверлей
          не перехватывал клик внутри модалки. */}
      <div
        style={{
          flex: '1 1 60%',
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
        }}
      >
        {displaySrc ? (
          <div style={{ position: 'relative', maxWidth: '100%', maxHeight: '100%' }}>
            <img
              src={displaySrc}
              alt="Документ"
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                userSelect: 'none',
                // Пока грузится оригинал — показываем миниатюру приглушённой,
                // чтобы было видно, что идёт загрузка более чёткой версии.
                opacity: fullUrl ? 1 : 0.5,
                transition: 'opacity 0.2s',
              }}
            />
            {!fullUrl && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Spin tip="Загрузка оригинала…" />
              </div>
            )}
          </div>
        ) : (
          <Spin />
        )}
      </div>

      {/* Справа: таблица материалов или статус. */}
      <div
        style={{
          flex: '1 1 40%',
          minWidth: 360,
          maxWidth: 560,
          background: '#fff',
          borderInlineStart: '1px solid #f0f0f0',
          padding: 16,
          overflow: 'auto',
        }}
      >
        <RecognitionPanel
          isLoading={recognition.isLoading || recognize.isPending}
          data={recognition.data ?? null}
          error={recognize.error ?? null}
          onRetry={() => recognize.mutate({ force: true })}
        />
      </div>
    </Modal>
  );
}

function RecognitionPanel({
  isLoading,
  data,
  error,
  onRetry,
}: {
  isLoading: boolean;
  data: PhotoRecognition | null;
  error: Error | null;
  onRetry: () => void;
}): JSX.Element {
  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          paddingTop: 48,
        }}
      >
        <Spin />
        <Typography.Text type="secondary">Распознаём материалы…</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Обычно занимает 10–30 сек.
        </Typography.Text>
      </div>
    );
  }
  if (error && !data) {
    return (
      <Alert
        type="error"
        showIcon
        message="Распознавание не удалось"
        description={error.message}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
            Повторить
          </Button>
        }
      />
    );
  }
  if (!data) {
    return <Typography.Text type="secondary">Нет данных.</Typography.Text>;
  }
  if (data.status === 'failed') {
    return (
      <Alert
        type="error"
        showIcon
        message="Распознавание не удалось"
        description={data.errorMessage ?? 'LLM вернул ошибку.'}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
            Повторить
          </Button>
        }
      />
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 8,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          Материалы {data.items.length > 0 && `(${data.items.length})`}
        </Typography.Title>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          Повторить
        </Button>
      </div>

      {/* Шапка документа: форма / номер / дата / итог / confidence. */}
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {data.docForm && (
          <Tag color="geekblue">
            {data.docForm === 'tn_2116'
              ? 'ТТН (1-Т)'
              : data.docForm === 'os2'
                ? 'ОС-2'
                : data.docForm}
          </Tag>
        )}
        {data.docNumber && <Tag>№ {data.docNumber}</Tag>}
        {data.docDate && <Tag>{data.docDate}</Tag>}
        {data.totalSum !== null && <Tag color="green">Итого: {formatMoney(data.totalSum)}</Tag>}
      </div>

      {data.items.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          message="В кадре не найдено позиций"
          description="Возможно, на этом фото шапка/подписи документа или нечитаемая страница. Попробуйте кликнуть на фото с табличной частью."
        />
      ) : (
        <Table<PhotoRecognitionItem>
          size="small"
          rowKey={(_, i) => String(i)}
          dataSource={data.items}
          pagination={false}
          showSorterTooltip={false}
          columns={[
            {
              title: '№',
              key: '__num__',
              width: 40,
              render: (_, __, idx) => idx + 1,
            },
            {
              title: 'Название',
              dataIndex: 'nameRaw',
              ellipsis: { showTitle: true },
            },
            {
              title: 'Кол-во',
              dataIndex: 'qty',
              width: 70,
              align: 'right' as const,
              render: (v: number | null | undefined) => (v == null ? '—' : formatNumber(v)),
            },
            {
              title: 'Ед.',
              dataIndex: 'unit',
              width: 64,
              render: (v: string | null | undefined) => v ?? '—',
            },
            {
              title: 'Цена',
              dataIndex: 'price',
              width: 90,
              align: 'right' as const,
              render: (v: number | null | undefined) => (v == null ? '—' : formatMoney(v)),
            },
            {
              title: 'Сумма',
              dataIndex: 'sum',
              width: 100,
              align: 'right' as const,
              render: (v: number | null | undefined) => (v == null ? '—' : formatMoney(v)),
            },
          ]}
        />
      )}
    </div>
  );
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(n);
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(n);
}
