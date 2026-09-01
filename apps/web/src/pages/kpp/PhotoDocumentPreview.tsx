import { useEffect, useState } from 'react';
import { Alert, Button, Image, Modal, Spin, Table, Tag, Tooltip, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PhotoRecognition, PhotoRecognitionItem } from '@matcheck/contracts';
import { suspectQtyPriceSwap } from '@matcheck/contracts';
import { api, apiDownload, ApiError } from '../../services/api';
import { UpdValidationSummary } from '../../shared/ui/UpdValidationSummary';
import { enqueueFullLoad } from '../../lib/thumbQueue';

/**
 * Пороги качества снимка по длинной стороне. Те же числа использует
 * apps/api/scripts/audit-photo-dims.ts: типичное фото документа с планшета ~2048px,
 * камера с заниженной настройкой размера отдаёт ~800px.
 */
const LOW_RES_PX = 1280;
const SUSPECT_RES_PX = 1600;

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
  afterClose,
  photoId,
  imageSrc,
}: {
  open: boolean;
  onClose: () => void;
  // Вызывается после полного закрытия модалки (rc-dialog afterClose). PhotoGallery
  // использует его, чтобы вернуть фокус во внешнюю модалку приёмки/отгрузки.
  afterClose?: () => void;
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
  // Разрешение оригинала. Меряем его отдельным экземпляром Image, а не onLoad на
  // разметке: antd <Image> раскладывает чужие пропсы на обёртку-div, до самого
  // <img> onLoad не доходит (rc-image/es/common.js — белый список COMMON_PROPS),
  // а событие load не всплывает. Заодно размеры по построению снимаются только с
  // оригинала — миниатюру 320px нельзя выдавать за разрешение фото, иначе каждое
  // открытие на мгновение обвиняет камеру в «низком разрешении».
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => setDims(null), [photoId]);
  useEffect(() => {
    if (!fullBlob.data) {
      setFullUrl(null);
      setDims(null);
      return;
    }
    const url = URL.createObjectURL(fullBlob.data);
    setFullUrl(url);
    // Старые размеры не должны пережить смену blob: иначе до срабатывания onload
    // они висят поверх уже другого кадра.
    setDims(null);
    const probe = new window.Image();
    probe.onload = () => setDims({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => setDims(null);
    probe.src = url;
    return () => {
      // Отменённый замер не должен записать размеры задним числом.
      probe.onload = null;
      probe.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [fullBlob.data]);
  // Оригинал когда загружен, иначе переданная миниатюра как быстрый плейсхолдер.
  const displaySrc = fullUrl ?? imageSrc;

  const fullDims = fullUrl ? dims : null;
  const longestSide = fullDims ? Math.max(fullDims.w, fullDims.h) : null;

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
      afterClose={afterClose}
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
      {/* Слева: фото. Зум даёт штатный antd-просмотрщик (клик по маске
          «Открыть для зума» разворачивает его поверх модалки) — то же решение,
          что в разделе «Документы», см. SourceDocumentDetailModal. Зум прямо в
          панели не делаем: справа бывает свой скролл, и колесо конфликтовало бы
          с ним. */}
      <div
        style={{
          flex: '1 1 60%',
          // Нейтральный светлый фон: на чёрном не видно границы листа, а мелкий кадр
          // читался как «фото в чёрной рамке», хотя рамка — это фон панели.
          background: '#f5f5f5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
        }}
      >
        {displaySrc ? (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <Image
              src={displaySrc}
              alt="Документ"
              // wrapperStyle — на обёртку .ant-image (она же ловит клик и держит
              // маску), style — на сам <img>.
              wrapperStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              style={{
                // width/height обязательны: без них objectFit не работает вовсе, и
                // кадр мельче панели рисовался в натуральную величину по центру.
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                userSelect: 'none',
                // Пока грузится оригинал — показываем миниатюру приглушённой,
                // чтобы было видно, что идёт загрузка более чёткой версии.
                opacity: fullUrl ? 1 : 0.5,
                transition: 'opacity 0.2s',
              }}
              preview={{ mask: 'Открыть для зума' }}
            />
            {fullDims && longestSide !== null && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(255, 255, 255, 0.85)',
                  // Оверлеи лежат поверх картинки — клик должен проходить сквозь
                  // них на маску «Открыть для зума».
                  pointerEvents: 'none',
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {fullDims.w}×{fullDims.h} px
                </Typography.Text>
                {longestSide < LOW_RES_PX && <Tag color="warning">низкое разрешение</Tag>}
                {longestSide >= LOW_RES_PX && longestSide < SUSPECT_RES_PX && (
                  <Tag>проверьте камеру</Tag>
                )}
              </div>
            )}
            {!fullUrl && !fullBlob.isError && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'none',
                }}
              >
                <Spin tip="Загрузка оригинала…" />
              </div>
            )}
            {fullBlob.isError && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(255, 255, 255, 0.85)',
                  pointerEvents: 'none',
                }}
              >
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Оригинал не загрузился — показана миниатюра
                </Typography.Text>
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

  // Каким путём разобрано фото. Различие не косметическое: у 'upd_vision'
  // items.sum — стоимость С налогом (графа 9), у 'photo_v1' — без него
  // (графа 5), и НДС там не извлекается вовсе.
  const isUpdParser = data.parser === 'upd_vision';

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
                : data.docForm === 'upd'
                  ? 'УПД'
                  : data.docForm}
          </Tag>
        )}
        {data.docNumber && <Tag>№ {data.docNumber}</Tag>}
        {data.docDate && <Tag>{data.docDate}</Tag>}
        {data.totalSum !== null && <Tag color="green">Итого: {formatMoney(data.totalSum)}</Tag>}
        {data.vatSum !== null && <Tag>НДС: {formatMoney(data.vatSum)}</Tag>}
      </div>

      {/* Сверка сумм — та же, что в карточке документа, и теми же словами.
          Есть только у УПД-ветки: терпимый промпт накладных не извлекает ни
          НДС, ни номера позиций, и посчитанная по его данным сверка врала бы. */}
      {data.validation && (
        <div style={{ marginBottom: 12 }}>
          <UpdValidationSummary
            failedChecks={data.validation.checks.filter((c) => !c.ok)}
            warnings={data.validation.warnings ?? []}
            storageKey="matcheck.photoDoc.validation"
          />
        </div>
      )}

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
          // Данные фото через серверную сверку не проходят — подозрение на
          // перестановку количества и цены считаем здесь же, на клиенте.
          onRow={(record) =>
            suspectQtyPriceSwap(record) ? { style: { background: '#fffbe6' } } : {}
          }
          columns={[
            {
              // У УПД-ветки — номер, НАПЕЧАТАННЫЙ в графе 1: по нему видно
              // дыру в списке (1, 3 — вторая строка потерялась). Прежний путь
              // номеров не читает, там остаётся порядковый индекс.
              title: '№',
              key: '__num__',
              width: 40,
              render: (_, record: PhotoRecognitionItem, idx) =>
                isUpdParser ? (record.rowNo ?? idx + 1) : idx + 1,
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
              // В подозрительной строке показываем цену как она распозналась, со
              // всеми знаками: именно необычная точность и есть повод для
              // предупреждения, а округление до копеек его прячет.
              render: (v: number | null | undefined, record: PhotoRecognitionItem) => {
                if (v == null) return '—';
                if (!suspectQtyPriceSwap(record)) return formatMoney(v);
                return (
                  <Tooltip title="Похоже, количество и цена стоят не в своих колонках — сверьте с документом">
                    <span style={{ borderBottom: '1px dashed #d48806' }}>
                      {formatMoneyPrecise(v)}
                    </span>
                  </Tooltip>
                );
              },
            },
            // НДС есть только у УПД-ветки: прежний промпт налог не извлекает,
            // и пустая колонка читалась бы как «налога в документе нет».
            ...(isUpdParser
              ? [
                  {
                    title: 'НДС',
                    dataIndex: 'vatSum',
                    width: 90,
                    align: 'right' as const,
                    render: (v: number | null | undefined) => (v == null ? '—' : formatMoney(v)),
                  },
                ]
              : []),
            {
              // Заголовок разный не для красоты: у УПД-ветки это графа 9
              // (с налогом), у прежней — графа 5 (без налога). Одна и та же
              // подпись над разными базами занижала бы строку на ставку.
              title: isUpdParser ? 'Сумма с НДС' : 'Сумма',
              dataIndex: 'sum',
              width: 110,
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

/** Цена как распозналась: до четырёх знаков, как её хранит база. */
function formatMoneyPrecise(n: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 4,
  }).format(n);
}

function formatMoney(n: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(n);
}
