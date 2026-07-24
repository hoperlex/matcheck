import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Image,
  Popconfirm,
  Popover,
  Radio,
  Space,
  Spin,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryPhoto,
  PhotoDeleteResponse,
  PhotoPatchResponse,
  ShipmentPhoto,
} from '@matcheck/contracts';
import { api, apiDownload, ApiError } from '../../services/api';
import { enqueueThumbLoad, enqueueFullLoad } from '../../lib/thumbQueue';
import { db, type OperationKind } from '../../lib/db';
import { useAuthStore } from '../../stores/auth';
import { PhotoDocumentPreview } from './PhotoDocumentPreview';

const THUMB_SIZE = 140;
// Фото загружаем через API-прокси /api/v1/photos/:id/content — сервер сам
// идёт в S3 и стримит файл. Тело фото неизменно по photo.id (после
// удаления запись физически исчезает из БД), поэтому кэшируем blob в
// react-query на бесконечность — повторного запроса по тому же id не
// будет. gcTime 30 мин освобождает память закрытых модалок.
const PHOTO_STALE = Infinity;
const PHOTO_GC = 30 * 60 * 1000;

type AnyPhoto = DeliveryPhoto | ShipmentPhoto;

export function PhotoGallery({
  deliveryId,
  photos,
  operationKind = 'delivery',
  readOnly = false,
}: {
  deliveryId: string;
  photos: AnyPhoto[];
  operationKind?: OperationKind;
  // readOnly: галерея используется в просмотре (например, в Истории
  // поступлений → модалка «Фото материала»). Кнопка удаления скрыта,
  // даже если пользователь admin. Семантически: «здесь смотрят, не правят».
  readOnly?: boolean;
}): JSX.Element | null {
  const role = useAuthStore((s) => s.user?.role);
  // admin + manager: оба полностью редактируют приёмки/отгрузки, удаление
  // отдельного фото — часть этих прав. Inspector_kpp на веб-портале фото
  // не правит; на мобиле он удаляет через свой UI.
  const canDelete = (role === 'admin' || role === 'manager') && !readOnly;
  // Изменение типа фото (kind) — те же роли. Симметрично canDelete.
  const canEditKind = (role === 'admin' || role === 'manager') && !readOnly;
  const queryClient = useQueryClient();
  const invalidateKey = operationKind === 'shipment' ? 'shipments' : 'deliveries';

  const del = useMutation<
    PhotoDeleteResponse,
    Error,
    string,
    { prevServer: unknown; prevLocal: unknown }
  >({
    mutationFn: async (id: string) => {
      const dbi = await db();
      const local = await dbi.get('photos', id);
      // Локальное несинхронизированное фото — на сервере его нет, не дёргаем бэк.
      if (local && !local.uploaded) {
        await dbi.delete('photos', id).catch(() => undefined);
        return { ok: true };
      }
      try {
        const result = await api.delete<PhotoDeleteResponse>(`/photos/${id}`);
        await dbi.delete('photos', id).catch(() => undefined);
        return result;
      } catch (err) {
        // Фото уже удалено на сервере (каскад / другой клиент) — чистим IDB и
        // считаем мутацию успешной, чтобы UI пришёл к консистентному состоянию.
        if (err instanceof ApiError && err.status === 404) {
          await dbi.delete('photos', id).catch(() => undefined);
          return { ok: true };
        }
        throw err;
      }
    },
    // Оптимистично убираем ТОЛЬКО удаляемое фото (по id) из обоих кэшей сразу,
    // не дожидаясь ответа сервера и следующего 5-сек polling'а. Остальной объект
    // приёмки/отгрузки и все прочие фото сохраняем как есть (…old + фильтр по id).
    onMutate: async (id: string) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: [invalidateKey, deliveryId] }),
        queryClient.cancelQueries({ queryKey: ['photos-local', operationKind, deliveryId] }),
      ]);
      const prevServer = queryClient.getQueryData([invalidateKey, deliveryId]);
      const prevLocal = queryClient.getQueryData(['photos-local', operationKind, deliveryId]);
      queryClient.setQueryData([invalidateKey, deliveryId], (old) => {
        if (!old || typeof old !== 'object' || !('photos' in old)) return old;
        const o = old as { photos?: AnyPhoto[] };
        if (!Array.isArray(o.photos)) return old;
        return { ...o, photos: o.photos.filter((p) => p.id !== id) };
      });
      queryClient.setQueryData(['photos-local', operationKind, deliveryId], (old) =>
        Array.isArray(old) ? (old as AnyPhoto[]).filter((p) => p.id !== id) : old,
      );
      return { prevServer, prevLocal };
    },
    onSuccess: async () => {
      message.success('Фото удалено');
      // Инвалидируем оба источника галереи: серверный snapshot приёмки/отгрузки
      // и локальный IDB-список (последний нужен, иначе только что удалённое фото
      // продолжит висеть в merged-списке до перерисовки страницы).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [invalidateKey, deliveryId] }),
        queryClient.invalidateQueries({ queryKey: ['photos-local', operationKind, deliveryId] }),
      ]);
    },
    onError: (err: Error, _id, ctx) => {
      // Откат оптимистичного удаления: возвращаем прежние снапшоты обоих кэшей.
      if (ctx) {
        queryClient.setQueryData([invalidateKey, deliveryId], ctx.prevServer);
        queryClient.setQueryData(['photos-local', operationKind, deliveryId], ctx.prevLocal);
      }
      message.error(err.message);
    },
  });

  // Изменение типа фото. Сохраняет только kind; всё остальное
  // (stage, s3Key, takenAt, file) — нетронуто. Бэк PATCH /api/v1/photos/:id.
  const patchKind = useMutation<
    PhotoPatchResponse,
    Error,
    { id: string; kind: 'document' | 'cargo' | 'vehicle' | 'other' }
  >({
    mutationFn: ({ id, kind }) => api.patch<PhotoPatchResponse>(`/photos/${id}`, { kind }),
    onSuccess: async () => {
      message.success('Тип фото изменён');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [invalidateKey, deliveryId] }),
        queryClient.invalidateQueries({
          queryKey: ['photos-local', operationKind, deliveryId],
        }),
      ]);
    },
    onError: (err: Error) => {
      // 404 — две частые причины: (1) backend на этом домене ещё не
      // задеплоен (нет нового маршрута PATCH /api/v1/photos/:id),
      // (2) свежезагруженное фото — на момент клика ещё в IDB-id,
      // server-confirm не успел подменить id. Объясняем явно, чтобы
      // пользователь не гадал.
      if (err instanceof ApiError && err.status === 404) {
        message.error(
          'Фото пока недоступно для смены типа: либо загрузка не завершилась, либо API-сервер ещё не обновлён.',
        );
        return;
      }
      message.error(err.message);
    },
  });

  if (photos.length === 0) return null;

  // Сортировка фото внутри stage'а (1/2 Этап родитель делит на отдельные
  // галереи через beforePhotos/afterPhotos): сначала Документы, затем
  // Груз/машина, в самом конце — фото с неизвестным kind. Внутри каждой
  // группы — стабильный порядок по takenAt (как было раньше), чтобы при
  // refetch / смене kind / добавлении нового фото порядок был детерминированным.
  // Делается на UI-уровне, БД не трогаем — это чистая визуальная группировка.
  const sorted = [...photos].sort((a, b) => {
    const rank = kindRank(a.kind) - kindRank(b.kind);
    if (rank !== 0) return rank;
    return a.takenAt.localeCompare(b.takenAt);
  });

  // Подписи «Документ» / «Груз/машина» под фото выводим только если у этой
  // галереи kind проставлен ОСМЫСЛЕННО — т.е. встречается хоть один
  // 'document' или 'vehicle'. Если же все фото имеют kind='cargo' (default
  // в БД для старых записей до запуска QR-детекта), значит backfill ещё
  // не прошёл и kind мы достоверно не знаем — лучше не показывать вообще
  // подпись, чем подписать документ как «Груз/машина».
  const showLabels = sorted.some((p) => p.kind === 'document' || p.kind === 'vehicle');

  // Открытое фото-документ для split-view модалки (фото + распознанные
  // материалы справа). Только для kind='document'; для cargo/vehicle
  // работает стандартный antd Image preview через PreviewGroup ниже.
  // Данные (docPreview) и видимость (docPreviewOpen) разделены намеренно:
  // rc-dialog вызывает afterClose только при переходе open true→false. Если
  // закрытие сразу обнулять docPreview, компонент размонтируется без этого
  // перехода и afterClose (возврат фокуса) не отработает. Поэтому закрытие
  // меняет только open, а очистку данных делаем в afterClose.
  const [docPreview, setDocPreview] = useState<{ id: string; src: string } | null>(null);
  const [docPreviewOpen, setDocPreviewOpen] = useState(false);
  const galleryRef = useRef<HTMLDivElement>(null);

  // После закрытия вложенной модалки просмотра документа rc-dialog возвращает
  // фокус на document.body (миниатюра-триггер — не focusable <img>), из-за чего
  // следующий ESC не доходит до внешней модалки «Приёмка»/«Отгрузка». Возвращаем
  // фокус на её .ant-modal-wrap — именно у него tabIndex=-1 и навешан onKeyDown
  // с обработкой ESC (rc-dialog@9.6.0). Тогда следующий keydown(ESC) снова
  // приходит на этот обработчик и модалка закрывается. В full-page режиме
  // (embedded=false) внешней модалки нет — closest вернёт null, focus — no-op.
  const restoreOuterModalFocus = () => {
    galleryRef.current
      ?.closest<HTMLElement>('.ant-modal-wrap')
      ?.focus({ preventScroll: true });
  };
  // afterClose (после полного закрытия): вернуть фокус, затем очистить данные.
  const handleDocPreviewAfterClose = () => {
    restoreOuterModalFocus();
    setDocPreview(null);
  };

  // Общий previewOpen-флаг для всей PreviewGroup: при открытии fullscreen
  // preview ЛЮБОГО фото он становится true → enabled для fullQuery
  // включается СРАЗУ у всех фото группы. Иначе antd-PreviewGroup листает
  // через стрелки на соседние фото, у которых local previewOpen остался
  // false, и preview показывает растянутый thumbnail 140 px вместо
  // оригинала. Текст на сканах документов в таком виде нечитаем.
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div
      ref={galleryRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, ${THUMB_SIZE}px)`,
        gap: 8,
        width: '100%',
      }}
    >
      <Image.PreviewGroup
        preview={{
          // Group-level callback вызывается на КАЖДОЕ открытие/закрытие
          // overlay'я, независимо от того, какую миниатюру кликнули и куда
          // потом листают стрелками. Это и есть единый сигнал «оригиналы
          // нужны прямо сейчас» для всех PhotoThumb группы.
          onVisibleChange: (vis) => setPreviewOpen(vis),
        }}
      >
        {sorted.map((p) => (
          <PhotoThumb
            key={p.id}
            photo={p}
            canDelete={canDelete}
            onDelete={() => del.mutate(p.id)}
            deleting={del.isPending && del.variables === p.id}
            canEditKind={canEditKind}
            onChangeKind={(kind) => patchKind.mutate({ id: p.id, kind })}
            changingKind={patchKind.isPending && patchKind.variables?.id === p.id}
            showLabel={showLabels}
            onDocumentClick={(src) => {
              setDocPreview({ id: p.id, src });
              setDocPreviewOpen(true);
            }}
            previewOpen={previewOpen}
          />
        ))}
      </Image.PreviewGroup>
      {docPreview && (
        <PhotoDocumentPreview
          open={docPreviewOpen}
          onClose={() => setDocPreviewOpen(false)}
          afterClose={handleDocPreviewAfterClose}
          photoId={docPreview.id}
          imageSrc={docPreview.src}
        />
      )}
    </div>
  );
}

// Человекочитаемая подпись по photo.kind. Возвращает null, если kind
// неинформативен ('other' или совсем неизвестное значение) — компонент
// тогда вообще не рисует подпись.
function kindLabel(kind: string | undefined): string | null {
  if (kind === 'document') return 'Документ';
  if (kind === 'cargo' || kind === 'vehicle') return 'Груз/машина';
  return null;
}

// Ранг для сортировки внутри stage'а: Документы первыми, Груз/машина
// после, всё неизвестное (other / null / нестандартные значения) —
// в самом конце, чтобы не падать на чужих данных и не мешать обычным
// фото. Stable secondary key — takenAt; собирается в основном
// comparator-е выше.
function kindRank(kind: string | undefined): number {
  if (kind === 'document') return 0;
  if (kind === 'cargo' || kind === 'vehicle') return 1;
  return 2;
}

function PhotoThumb({
  photo,
  canDelete,
  onDelete,
  deleting,
  canEditKind,
  onChangeKind,
  changingKind,
  showLabel,
  onDocumentClick,
  previewOpen,
}: {
  photo: AnyPhoto;
  canDelete: boolean;
  onDelete: () => void;
  deleting: boolean;
  // Может ли пользователь сменить тип фото (kind). Шире, чем canDelete:
  // admin + manager. Inspector_kpp правит тип только на мобиле.
  canEditKind: boolean;
  onChangeKind: (kind: 'document' | 'cargo' | 'vehicle' | 'other') => void;
  changingKind: boolean;
  // false — родитель просит не показывать подпись (kind ненадёжен,
  // backfill ещё не прошёл). См. PhotoGallery.showLabels.
  showLabel: boolean;
  // Для kind='document' клик перехватывается и открывает split-view
  // модалку с распознанными материалами справа. Стандартный antd preview
  // в этом случае отключён.
  onDocumentClick: (fullSrc: string) => void;
  // Общий для всей PreviewGroup флаг: true, когда у пользователя открыт
  // fullscreen-overlay (с любым из фото группы). Триггерит ленивую
  // загрузку оригинала ДЛЯ ВСЕХ фото — чтобы листание стрелками между
  // фото показывало оригиналы, а не растянутые миниатюры.
  previewOpen: boolean;
}): JSX.Element {
  const label = showLabel ? kindLabel(photo.kind) : null;
  const isDocument = photo.kind === 'document';
  const [localThumb, setLocalThumb] = useState<string | null>(null);
  const [localFull, setLocalFull] = useState<string | null>(null);
  const [idbChecked, setIdbChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let thumbUrl: string | null = null;
    let fullUrl: string | null = null;
    void (async () => {
      try {
        const dbi = await db();
        const rec = await dbi.get('photos', photo.id);
        if (cancelled) return;
        if (rec?.thumbBlob) thumbUrl = URL.createObjectURL(rec.thumbBlob);
        if (rec?.blob) fullUrl = URL.createObjectURL(rec.blob);
        setLocalThumb(thumbUrl);
        setLocalFull(fullUrl ?? thumbUrl);
      } finally {
        if (!cancelled) setIdbChecked(true);
      }
    })();
    return () => {
      cancelled = true;
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      if (fullUrl) URL.revokeObjectURL(fullUrl);
    };
  }, [photo.id]);

  // Серверная запись с uploaded_at = null — мобильный клиент уже создал orphan
  // через /photos/presign, но PUT в S3 ещё не подтвердил. Локального blob у
  // веб-юзера нет. Запрашивать URL бессмысленно (S3 вернёт 404/Forbidden), а
  // показывать сломанную картинку — плохой UX. Рисуем «Загружается…» поверх
  // плейсхолдера и ждём, пока confirm проставит uploaded_at: KppPage рефетчит
  // delivery каждые несколько секунд, пока в photos есть хоть один orphan.
  const isUploading = photo.uploadedAt === null && !localThumb;
  const needsRemote = idbChecked && !localThumb && !isUploading;

  // previewOpen приходит сверху (из PhotoGallery) — это общий флаг на всю
  // PreviewGroup, см. комментарий у его объявления в родительском
  // компоненте. Каждый PhotoThumb не держит свой локальный — иначе
  // PreviewGroup листает к фото, у которого enabled=false, и antd
  // показывает растянутую миниатюру вместо оригинала.

  // Качаем blob миниатюры через API-прокси (сервер стримит S3 → клиент).
  // Это даёт стабильную загрузку: сервер ↔ S3 в одной сети, нет ERR_-
  // CONNECTION_RESET от прямых параллельных GET к Cloud.ru. Кэш blob'а
  // живёт по photo.id (фото immutable), повторного запроса по тому же
  // id не будет — staleTime: Infinity. retry=2 — два быстрых перезапроса
  // с экспоненциальным backoff, дальше react-query останавливается и
  // ниже показываем явный broken-state с кнопкой «Повторить».
  //
  // enqueueThumbLoad — глобальная очередь параллельных запросов, лимит 4.
  // Защищает API: 20 одновременных пользователей с галереями по 10 фото
  // не превратятся в 200 одновременных стримов S3-прокси.
  const thumbQuery = useQuery({
    queryKey: ['photo-blob', photo.id, 'thumb'],
    queryFn: () =>
      enqueueThumbLoad(async () => {
        const { blob } = await apiDownload(`/photos/${photo.id}/content?thumb=true`);
        return blob;
      }),
    enabled: needsRemote,
    staleTime: PHOTO_STALE,
    gcTime: PHOTO_GC,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    refetchOnWindowFocus: false,
  });
  const fullQuery = useQuery({
    queryKey: ['photo-blob', photo.id, 'full'],
    // enqueueFullLoad — очередь с лимитом 3: previewOpen включает fullQuery у
    // ВСЕХ фото группы разом, без лимита это шквал тяжёлых оригиналов к API/S3.
    queryFn: () =>
      enqueueFullLoad(async () => {
        const { blob } = await apiDownload(`/photos/${photo.id}/content`);
        return blob;
      }),
    // Оригинал тяжёлый (1-5 МБ) — грузим только при реальном открытии
    // preview, не превентивно. До этого пользователь видит миниатюру,
    // ничего лишнего не качается. enabled триггерится previewOpen из
    // controlled antd Image, см. ниже onVisibleChange.
    enabled: needsRemote && previewOpen,
    staleTime: PHOTO_STALE,
    gcTime: PHOTO_GC,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    refetchOnWindowFocus: false,
  });

  // Object URL'ы из blob — живут пока компонент смонтирован; при смене
  // photo.id (key={p.id} в map → новый mount) старые автоматически
  // отзываются через cleanup. Без revoke браузер держит blob в памяти
  // до выгрузки документа — на тысяче фото это заметная утечка.
  const [thumbObjectUrl, setThumbObjectUrl] = useState<string | null>(null);
  const [fullObjectUrl, setFullObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumbQuery.data) {
      setThumbObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(thumbQuery.data);
    setThumbObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [thumbQuery.data]);
  useEffect(() => {
    if (!fullQuery.data) {
      setFullObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(fullQuery.data);
    setFullObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [fullQuery.data]);

  const thumbSrc = localThumb ?? thumbObjectUrl ?? '';
  const fullSrc = localFull ?? fullObjectUrl ?? thumbSrc;

  // Error-state: явная плитка вместо бесконечного спиннера. retry: 2
  // в useQuery уже отработал, дальше пользователь сам решает.
  // Видна когда: нужен серверный thumb (нет localThumb / не uploading) +
  // запрос упал в isError. Локальные blob этой ветки не достигают.
  const showThumbError = needsRemote && !localThumb && thumbQuery.isError;

  if (isUploading) {
    return (
      <div style={{ width: THUMB_SIZE }}>
        <div
          style={{
            position: 'relative',
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: '#fafafa',
            border: '1px dashed #d9d9d9',
            borderRadius: 6,
          }}
        >
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Загружается…
          </Typography.Text>
          {/* Кнопка удаления для orphan-фото: серверная запись есть, локального
            blob нет, реальный PUT в S3 не подтвердился (timeout, дабл-клик,
            обрыв сети). Без этой кнопки пользователь должен ждать час, пока
            фоновая job photoOrphanCleanup сама удалит. */}
          {canDelete && (
            <Popconfirm
              title="Удалить незавершённую загрузку?"
              description="Фото не было загружено в S3. Запись будет удалена."
              okText="Да, удалить"
              cancelText="Нет"
              okButtonProps={{ danger: true }}
              onConfirm={onDelete}
            >
              <Button
                danger
                size="small"
                shape="circle"
                icon={<DeleteOutlined />}
                loading={deleting}
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  background: 'rgba(255, 255, 255, 0.9)',
                  zIndex: 1,
                }}
              />
            </Popconfirm>
          )}
        </div>
        {label && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', textAlign: 'center', marginTop: 4 }}
          >
            {label}
          </Typography.Text>
        )}
      </div>
    );
  }

  if (showThumbError) {
    return (
      <div style={{ width: THUMB_SIZE }}>
        <div
          style={{
            position: 'relative',
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: '#fff1f0',
            border: '1px solid #ffa39e',
            borderRadius: 6,
          }}
        >
          <WarningOutlined style={{ fontSize: 22, color: '#cf1322' }} />
          <Typography.Text type="secondary" style={{ fontSize: 11, textAlign: 'center' }}>
            Не загрузилось
          </Typography.Text>
          <Tooltip title="Повторить загрузку">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void thumbQuery.refetch()}
              loading={thumbQuery.isFetching}
            >
              Повтор
            </Button>
          </Tooltip>
          {canDelete && (
            <Popconfirm
              title="Удалить фото?"
              okText="Да"
              cancelText="Нет"
              okButtonProps={{ danger: true }}
              onConfirm={onDelete}
            >
              <Button
                danger
                size="small"
                shape="circle"
                icon={<DeleteOutlined />}
                loading={deleting}
                style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
              />
            </Popconfirm>
          )}
        </div>
        {label && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', textAlign: 'center', marginTop: 4 }}
          >
            {label}
          </Typography.Text>
        )}
      </div>
    );
  }

  return (
    <div style={{ width: THUMB_SIZE }}>
      <div style={{ position: 'relative', width: THUMB_SIZE, height: THUMB_SIZE }}>
        <Image
          src={thumbSrc}
          // У документов перехватываем клик и открываем свою split-view
          // модалку (фото + распознанные позиции справа), стандартный
          // antd preview отключаем. У cargo/vehicle всё как раньше.
          preview={
            isDocument
              ? false
              : {
                  src: fullSrc,
                  // visible/onVisibleChange здесь НЕ задаём:
                  // PreviewGroup сам контролирует видимость overlay'я и
                  // дёргает свой собственный onVisibleChange (см.
                  // PhotoGallery → Image.PreviewGroup preview prop).
                  // Локальный controlled-state в PhotoThumb приводил к
                  // тому, что enabled у fullQuery вспыхивал только на том
                  // фото, которое было кликнуто первым, а у соседних
                  // (доступных через стрелки) оставался false → preview
                  // показывал растянутый thumb.
                }
          }
          width={THUMB_SIZE}
          height={THUMB_SIZE}
          style={{
            objectFit: 'cover',
            borderRadius: 6,
            cursor: isDocument ? 'pointer' : undefined,
          }}
          onClick={isDocument ? () => onDocumentClick(fullSrc) : undefined}
          placeholder={
            <div
              style={{
                width: THUMB_SIZE,
                height: THUMB_SIZE,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#fafafa',
                borderRadius: 6,
              }}
            >
              <Spin size="small" />
            </div>
          }
        />
        {canDelete && (
          <Popconfirm
            title="Удалить фото?"
            description="Файл будет удалён из хранилища без возможности восстановления."
            okText="Да, удалить"
            cancelText="Нет"
            okButtonProps={{ danger: true }}
            onConfirm={onDelete}
          >
            <Button
              danger
              size="small"
              shape="circle"
              icon={<DeleteOutlined />}
              loading={deleting}
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                background: 'rgba(255, 255, 255, 0.9)',
                zIndex: 1,
              }}
            />
          </Popconfirm>
        )}
      </div>
      <PhotoLabelRow
        label={label}
        canEditKind={canEditKind}
        currentKind={photo.kind}
        onChangeKind={onChangeKind}
        changing={changingKind}
        // PATCH /photos/:id обращается по server-id. Свежезагруженное
        // фото до момента confirm живёт под локальным IDB-uuid, и сервер
        // про него ничего не знает → PATCH вернёт 404. Пока uploadedAt
        // не проставлен, не даём кликать.
        pendingUpload={photo.uploadedAt === null}
      />
    </div>
  );
}

/**
 * Подпись «Документ»/«Груз/машина» под миниатюрой + (для admin/manager)
 * иконка-карандаш, открывающая Popover для смены kind. Показывается
 * только в normal-render ветке: в uploading/error состояниях правка
 * типа не нужна.
 *
 * Если подписи нет (showLabel=false — kind не разрешён в этой галерее)
 * И смена недоступна — компонент не рендерит ничего, чтобы не плодить
 * пустой DOM-узел.
 */
function PhotoLabelRow({
  label,
  canEditKind,
  currentKind,
  onChangeKind,
  changing,
  pendingUpload,
}: {
  label: string | null;
  canEditKind: boolean;
  currentKind: string | undefined;
  onChangeKind: (kind: 'document' | 'cargo' | 'vehicle' | 'other') => void;
  changing: boolean;
  // true — фото ещё не подтверждено сервером (uploadedAt=null). Сервер
  // не знает про него по тому id, что у нас в галерее (после confirm
  // photoPipeline перепишет IDB-id на server-id). До этого PATCH
  // вернул бы 404 — disable-им кнопку, чтобы пользователь не путался.
  pendingUpload: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!label && !canEditKind) return null;
  const editorDisabled = pendingUpload || changing;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        marginTop: 4,
        minHeight: 16,
      }}
    >
      {label && (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {label}
        </Typography.Text>
      )}
      {canEditKind && (
        <Popover
          // Пока фото не подтверждено сервером — Popover не открывается
          // вовсе (open всегда false). disabled у кнопки + tooltip
          // объясняют почему. После confirm photoPipeline переподпишет
          // IDB-id на server-id, при следующем рендере pendingUpload
          // станет false и UI разблокируется автоматически.
          open={editorDisabled ? false : open}
          onOpenChange={(v) => {
            if (editorDisabled) return;
            setOpen(v);
          }}
          trigger="click"
          placement="bottom"
          destroyTooltipOnHide
          content={
            <div style={{ width: 200 }}>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, display: 'block', marginBottom: 6 }}
              >
                Тип фото
              </Typography.Text>
              <Radio.Group
                value={currentKind === 'document' ? 'document' : 'cargo'}
                onChange={(e) => {
                  const next = e.target.value as 'document' | 'cargo';
                  onChangeKind(next);
                  setOpen(false);
                }}
              >
                <Space direction="vertical">
                  <Radio value="document">Документ</Radio>
                  <Radio value="cargo">Груз/машина</Radio>
                </Space>
              </Radio.Group>
            </div>
          }
        >
          <Tooltip
            title={pendingUpload ? 'Дождитесь окончания загрузки фото' : 'Изменить тип фото'}
          >
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              loading={changing}
              disabled={editorDisabled}
              style={{
                fontSize: 10,
                color: '#bfbfbf',
                padding: '0 4px',
                height: 18,
                minWidth: 0,
              }}
            />
          </Tooltip>
        </Popover>
      )}
    </div>
  );
}
