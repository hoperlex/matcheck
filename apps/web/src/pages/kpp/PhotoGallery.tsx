import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryPhoto,
  PageId,
  PhotoDeleteResponse,
  PhotoPatchResponse,
  ShipmentPhoto,
} from '@matcheck/contracts';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { api, apiDownload, ApiError } from '../../services/api';
import { uploadPhoto } from '../../services/photoPipeline';
import { enqueueThumbLoad, enqueueFullLoad } from '../../lib/thumbQueue';
import { withDb, type OperationKind } from '../../lib/db';
import { localCacheEnabled } from '../../lib/localCache';
import { useMarkViewedAfterDwell, useViewedPhotos } from '../../lib/photoViewed';
import { PhotoDocumentPreview, type PhotoDocumentNav } from './PhotoDocumentPreview';

const THUMB_SIZE = 140;
// Фото загружаем через API-прокси /api/v1/photos/:id/content — сервер сам
// идёт в S3 и стримит файл. Тело фото неизменно по photo.id (после
// удаления запись физически исчезает из БД), поэтому кэшируем blob в
// react-query на бесконечность — повторного запроса по тому же id не
// будет. gcTime 30 мин освобождает память закрытых модалок.
const PHOTO_STALE = Infinity;
const PHOTO_GC = 30 * 60 * 1000;

type AnyPhoto = DeliveryPhoto | ShipmentPhoto;

/**
 * Фото в галерее = серверный контракт + локальное состояние отправки из IDB.
 * Отдельным типом, а не полями в DeliveryPhoto/ShipmentPhoto: те описывают
 * ответ API и не должны знать про очередь браузера.
 */
export type GalleryPhoto = AnyPhoto & {
  uploadState?: 'pending' | 'blocked';
  uploadAttempts?: number;
  nextRetryAt?: number;
  lastUploadError?: { status?: number; code: string; at: number };
};

/**
 * Текст сбоя для плитки. lastUploadError хранит код и статус, но не текст —
 * пользователю нужен человеческий смысл, а не `network`/`403`.
 */
function uploadErrorText(err: { status?: number; code: string }): string {
  if (err.code === 'network' || err.code === 'timeout') return 'Нет связи с сервером';
  if (err.code === 'forbidden' || err.status === 403) return 'Нет прав на это фото';
  if (err.code === 'pending_deletion') return 'Документ помечен на удаление';
  if (err.code === 'delivery_not_found' || err.code === 'shipment_not_found') {
    return 'Приёмка не найдена на сервере';
  }
  if (err.code === 'file_too_large') return 'Файл слишком большой';
  if (err.status != null && err.status >= 500) return 'Сервер недоступен';
  return 'Не удалось отправить';
}

export function PhotoGallery({
  deliveryId,
  photos,
  operationKind = 'delivery',
  readOnly = false,
}: {
  deliveryId: string;
  photos: GalleryPhoto[];
  operationKind?: OperationKind;
  // readOnly: галерея используется в просмотре (например, в Истории
  // поступлений → модалка «Фото материала»). Кнопка удаления скрыта,
  // даже если пользователь admin. Семантически: «здесь смотрят, не правят».
  readOnly?: boolean;
}): JSX.Element | null {
  // Право = ячейка И возможность маршрута. Одной ячейки мало: у инспектора
  // operations.*:delete базово есть, но DELETE /photos/:id открыт только
  // admin/manager — по ячейке мы нарисовали бы ему кнопку, отвечающую 403.
  // Одной возможности тоже мало: снятое администратором право обязано убрать
  // кнопку, даже если allow-list маршрута роль пропускает.
  const { can, hasCapability } = usePermissions();
  const page: PageId =
    operationKind === 'shipment' ? 'operations.shipments' : 'operations.deliveries';
  const managePhotos = hasCapability('operations.photo.manage');
  const canDelete = can(page, 'delete') && managePhotos && !readOnly;
  // Изменение типа кадра — правка операции, не удаление.
  const canEditKind = can(page, 'edit') && managePhotos && !readOnly;
  const queryClient = useQueryClient();
  const invalidateKey = operationKind === 'shipment' ? 'shipments' : 'deliveries';

  const del = useMutation<
    PhotoDeleteResponse,
    Error,
    string,
    { prevServer: unknown; prevLocal: unknown }
  >({
    mutationFn: async (id: string) => {
      // База и сеть — порознь: `withDb` повторяет свой колбэк на новом
      // соединении, если браузер закрыл старое, и DELETE ушёл бы дважды.
      const forgetLocal = () =>
        withDb((dbi) => dbi.delete('photos', id)).catch(() => undefined);
      const local = await withDb((dbi) => dbi.get('photos', id));
      // Локальное несинхронизированное фото — на сервере его нет, не дёргаем бэк.
      if (local && !local.uploaded) {
        await forgetLocal();
        return { ok: true };
      }
      try {
        const result = await api.delete<PhotoDeleteResponse>(`/photos/${id}`);
        await forgetLocal();
        return result;
      } catch (err) {
        // Фото уже удалено на сервере (каскад / другой клиент) — чистим IDB и
        // считаем мутацию успешной, чтобы UI пришёл к консистентному состоянию.
        if (err instanceof ApiError && err.status === 404) {
          await forgetLocal();
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

  // Все хуки — строго до early-return ниже: у галереи без фото он срабатывал
  // раньше этих useState/useRef, и появление первого фото меняло число хуков
  // между рендерами (React: «Rendered more hooks than during the previous
  // render»). Пояснения к каждому состоянию — у мест, где они используются.
  //
  // docPreview (данные) и docPreviewOpen (видимость) разделены намеренно:
  // rc-dialog вызывает afterClose только при переходе open true→false. Если
  // закрытие сразу обнуляет docPreview, компонент размонтируется без этого
  // перехода и afterClose (возврат фокуса) не отработает.
  // inList — документ из списка листания (подтверждён сервером). Открытый до
  // подтверждения загрузки живёт под локальным id: листания и отметки у него нет.
  const [docPreview, setDocPreview] = useState<{
    id: string;
    src: string;
    inList: boolean;
  } | null>(null);
  const [docPreviewOpen, setDocPreviewOpen] = useState(false);
  const galleryRef = useRef<HTMLDivElement>(null);
  // Общий previewOpen-флаг для всей PreviewGroup: при открытии fullscreen
  // preview ЛЮБОГО фото он становится true → enabled для fullQuery включается
  // сразу у всех фото группы.
  const [previewOpen, setPreviewOpen] = useState(false);
  const viewed = useViewedPhotos();

  // Сортировка фото внутри stage'а (1/2 Этап родитель делит на отдельные
  // галереи через beforePhotos/afterPhotos): сначала Документы, затем
  // Груз/машина, в самом конце — фото с неизвестным kind. Внутри каждой
  // группы — стабильный порядок по takenAt (как было раньше), чтобы при
  // refetch / смене kind / добавлении нового фото порядок был детерминированным.
  // Делается на UI-уровне, БД не трогаем — это чистая визуальная группировка.
  const sorted = useMemo(
    () =>
      [...photos].sort((a, b) => {
        const rank = kindRank(a.kind) - kindRank(b.kind);
        if (rank !== 0) return rank;
        return a.takenAt.localeCompare(b.takenAt);
      }),
    [photos],
  );
  // Документы для листания ←/→ в окне просмотра — в порядке миниатюр.
  const docIds = useMemo(
    () => sorted.filter((p) => p.kind === 'document' && p.uploadedAt !== null).map((p) => p.id),
    [sorted],
  );

  // Реестр адресов картинок, его заполняют миниатюры:
  //   - id → миниатюра: плейсхолдер в окне документа, пока качается оригинал
  //     соседнего документа, к которому перелистали;
  //   - адрес ОРИГИНАЛА → id: какое фото сейчас на экране штатного просмотра
  //     antd (груз/машина). Адреса миниатюр сюда не попадают — растянутая
  //     миниатюра просмотром не считается.
  const srcRegistry = useRef({
    thumbById: new Map<string, string>(),
    originalById: new Map<string, string>(),
    idByOriginal: new Map<string, string>(),
  });
  const registerSrc = useCallback((id: string, thumb: string, original: string | null) => {
    const r = srcRegistry.current;
    if (thumb) r.thumbById.set(id, thumb);
    const prev = r.originalById.get(id);
    if (prev && prev !== original) r.idByOriginal.delete(prev);
    if (original) {
      r.originalById.set(id, original);
      r.idByOriginal.set(original, id);
    } else {
      r.originalById.delete(id);
    }
  }, []);
  const resolveOriginal = useCallback(
    (url: string | undefined) => (url ? (srcRegistry.current.idByOriginal.get(url) ?? null) : null),
    [],
  );

  // Отметка документа: оригинал нарисован в окне (onOriginalDisplayed) и
  // простоял секунду. Сброс displayedDocId при листании и закрытии.
  const [displayedDocId, setDisplayedDocId] = useState<string | null>(null);
  useMarkViewedAfterDwell(
    docPreview && docPreviewOpen && docPreview.inList && displayedDocId === docPreview.id
      ? docPreview.id
      : null,
  );

  const openDoc = useCallback((id: string, src: string, inList: boolean) => {
    setDisplayedDocId(null);
    setDocPreview({ id, src, inList });
    setDocPreviewOpen(true);
  }, []);
  // Отметка фото груза/машины: оригинал на экране просмотра antd (сообщает
  // PreviewShownReporter) и просмотр открыт. Закрытие гасит отсчёт здесь, в
  // галерее: внутрь закрытого окна обновления уже не доходят.
  const [cargoShownId, setCargoShownId] = useState<string | null>(null);
  useMarkViewedAfterDwell(previewOpen ? cargoShownId : null);

  const goToDoc = useCallback(
    (id: string) => openDoc(id, srcRegistry.current.thumbById.get(id) ?? '', true),
    [openDoc],
  );

  // Список документов поменялся, пока окно открыто: открытое фото удалили или
  // сменили ему тип с другого клиента (приходит очередным обновлением
  // приёмки). Оставлять в окне фото, которого в приёмке уже нет, нельзя —
  // переходим на документ с тем же номером, а если его нет — на предыдущий;
  // документов не осталось — закрываем окно.
  const docIdsKey = docIds.join(',');
  const prevDocIdsRef = useRef<string[]>(docIds);
  useEffect(() => {
    const prev = prevDocIdsRef.current;
    prevDocIdsRef.current = docIds;
    if (!docPreview || !docPreviewOpen || !docPreview.inList) return;
    if (docIds.includes(docPreview.id)) return;
    message.info('Документ удалён или сменил тип');
    if (docIds.length === 0) {
      setDocPreviewOpen(false);
      return;
    }
    const oldIndex = Math.max(0, prev.indexOf(docPreview.id));
    const next = docIds[Math.min(oldIndex, docIds.length - 1)];
    if (next) goToDoc(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docIdsKey]);

  const docIndex = docPreview?.inList ? docIds.indexOf(docPreview.id) : -1;
  const docNav: PhotoDocumentNav | undefined =
    docIndex >= 0 && docIds.length > 1
      ? {
          index: docIndex,
          total: docIds.length,
          onPrev: () => {
            const id = docIds[docIndex - 1];
            if (id) goToDoc(id);
          },
          onNext: () => {
            const id = docIds[docIndex + 1];
            if (id) goToDoc(id);
          },
        }
      : undefined;

  if (photos.length === 0) return null;

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

  // После закрытия вложенной модалки просмотра документа rc-dialog возвращает
  // фокус на document.body (миниатюра-триггер — не focusable <img>), из-за чего
  // следующий ESC не доходит до внешней модалки «Приёмка»/«Отгрузка». Возвращаем
  // фокус на её .ant-modal-wrap — именно у него tabIndex=-1 и навешан onKeyDown
  // с обработкой ESC (rc-dialog@9.6.0). Тогда следующий keydown(ESC) снова
  // приходит на этот обработчик и модалка закрывается. В full-page режиме
  // (embedded=false) внешней модалки нет — closest вернёт null, focus — no-op.
  const restoreOuterModalFocus = () => {
    galleryRef.current?.closest<HTMLElement>('.ant-modal-wrap')?.focus({ preventScroll: true });
  };
  // afterClose (после полного закрытия): вернуть фокус, затем очистить данные.
  const handleDocPreviewAfterClose = () => {
    restoreOuterModalFocus();
    setDocPreview(null);
    setDisplayedDocId(null);
  };

  // Общий previewOpen-флаг для всей PreviewGroup: при открытии fullscreen
  // preview ЛЮБОГО фото он становится true → enabled для fullQuery
  // включается СРАЗУ у всех фото группы. Иначе antd-PreviewGroup листает
  // через стрелки на соседние фото, у которых local previewOpen остался
  // false, и preview показывает растянутый thumbnail 140 px вместо
  // оригинала. Текст на сканах документов в таком виде нечитаем.

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
          // Какое фото сейчас на экране просмотра — по адресу картинки. Индекс
          // из onChange не годится: rc-image нумерует кадры в порядке
          // монтирования миниатюр, а не в порядке сортировки галереи.
          // Репортёр ничего не рисует, только сообщает id показанного
          // оригинала.
          imageRender: (node, info) => (
            <>
              {node}
              <PreviewShownReporter
                photoId={resolveOriginal(info.image?.url)}
                url={info.image?.url}
                onShown={setCargoShownId}
              />
            </>
          ),
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
            onDocumentClick={(src) => openDoc(p.id, src, docIds.includes(p.id))}
            previewOpen={previewOpen}
            viewedAt={p.uploadedAt !== null ? viewed[p.id] : undefined}
            onSrc={registerSrc}
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
          operationKind={operationKind}
          nav={docNav}
          onOriginalDisplayed={setDisplayedDocId}
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

/**
 * Что сейчас на экране штатного просмотра antd (груз/машина) — для отметки
 * «просмотрено». Сообщает id фото, только когда на экране оригинал (id найден
 * по его адресу — у растянутой миниатюры id нет) и картинка действительно
 * декодируется: пробный Image с тем же адресом дождался onload. Иначе — null.
 *
 * Сам отсчёт секунды ведёт галерея, а не этот компонент: rc-dialog держит
 * содержимое закрытого окна замороженным (MemoChildren с shouldUpdate =
 * visible), и проп «просмотр закрыт» сюда бы уже не дошёл — таймер внутри
 * отметил бы фото после закрытия.
 */
function PreviewShownReporter({
  photoId,
  url,
  onShown,
}: {
  photoId: string | null;
  url: string | undefined;
  onShown: (photoId: string | null) => void;
}): null {
  const [decodedUrl, setDecodedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photoId || !url) return;
    let cancelled = false;
    const probe = new window.Image();
    probe.onload = () => {
      if (!cancelled) setDecodedUrl(url);
    };
    probe.src = url;
    return () => {
      cancelled = true;
      probe.onload = null;
    };
  }, [photoId, url]);
  const shown = photoId && url && decodedUrl === url ? photoId : null;
  useEffect(() => onShown(shown), [shown, onShown]);
  return null;
}

function formatViewedAt(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  viewedAt,
  onSrc,
}: {
  photo: GalleryPhoto;
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
  /** Когда текущий пользователь смотрел это фото; нет — не смотрел. */
  viewedAt?: number;
  /** Сообщить галерее адреса миниатюры и оригинала (null — оригинала ещё нет). */
  onSrc?: (id: string, thumb: string, original: string | null) => void;
}): JSX.Element {
  const label = showLabel ? kindLabel(photo.kind) : null;
  const isDocument = photo.kind === 'document';
  const [localThumb, setLocalThumb] = useState<string | null>(null);
  const [localFull, setLocalFull] = useState<string | null>(null);
  const [idbChecked, setIdbChecked] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Ручной повтор отправки. Ошибку не пробрасываем: uploadPhoto уже записал её
  // в IDB, а перерисовку галереи вызовет подписка на onPhotoUploadSettled в
  // родительском экране — она же отработает и после фонового ретрая.
  const retryUpload = async (): Promise<void> => {
    setRetrying(true);
    try {
      await uploadPhoto(photo.id);
    } catch {
      // состояние уже зафиксировано в IDB
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let thumbUrl: string | null = null;
    let fullUrl: string | null = null;
    void (async () => {
      try {
        const rec = localCacheEnabled()
          ? await withDb((dbi) => dbi.get('photos', photo.id))
          : undefined;
        if (cancelled) return;
        if (rec?.thumbBlob) thumbUrl = URL.createObjectURL(rec.thumbBlob);
        if (rec?.blob) fullUrl = URL.createObjectURL(rec.blob);
        setLocalThumb(thumbUrl);
        // Раньше сюда подставлялась миниатюра, когда полноразмерного blob нет.
        // С удалением blob у подтверждённых фото (photoPipeline) это означало
        // бы, что при открытии превью пользователь навсегда видит снимок
        // 320px: needsRemoteFull ниже считает, что оригинал уже есть. Держим
        // localFull честным — нет blob, значит оригинал грузим с сервера.
        setLocalFull(fullUrl);
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
  // Миниатюра и оригинал живут в базе по отдельности: у подтверждённого фото
  // остаётся только миниатюра, и оригинал нужно догрузить, даже когда
  // needsRemote уже false.
  const needsRemoteFull = idbChecked && !localFull && !isUploading;

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
    enabled: needsRemoteFull && previewOpen,
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
  const originalSrc = localFull ?? fullObjectUrl ?? null;
  const fullSrc = originalSrc ?? thumbSrc;

  // Layout-эффект, а не обычный: просмотр antd получает новый адрес картинки
  // следующим рендером (регистрация кадра в группе — state rc-image), и к
  // этому моменту адрес оригинала уже должен лежать в реестре галереи.
  useLayoutEffect(() => {
    onSrc?.(photo.id, thumbSrc, originalSrc);
  }, [onSrc, photo.id, thumbSrc, originalSrc]);

  // Error-state: явная плитка вместо бесконечного спиннера. retry: 2
  // в useQuery уже отработал, дальше пользователь сам решает.
  // Видна когда: нужен серверный thumb (нет localThumb / не uploading) +
  // запрос упал в isError. Локальные blob этой ветки не достигают.
  const showThumbError = needsRemote && !localThumb && thumbQuery.isError;

  // Отправка не удалась: запись ещё локальная, и по ней есть зафиксированная
  // ошибка. Раньше это состояние было невидимым — локальному фото проставляли
  // непустой uploadedAt, галерея считала его загруженным, и пользователь узнавал
  // о потере только когда фото не появлялось на планшете.
  //
  // Смотрим именно lastUploadError, а не uploadState: у ретраибельных сбоев
  // (сеть, 5xx, таймаут) uploadState не выставляется вовсе — он только у
  // терминальных. См. recordUploadFailure в photoPipeline.ts.
  const uploadFailed = photo.uploadedAt === null && !!photo.lastUploadError;

  if (uploadFailed && photo.lastUploadError) {
    const blocked = photo.uploadState === 'blocked';
    return (
      <div style={{ width: THUMB_SIZE }}>
        <div
          style={{
            position: 'relative',
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            borderRadius: 6,
            overflow: 'hidden',
            border: '1px solid #ffa39e',
            background: '#fff1f0',
          }}
        >
          {/* Кадр показываем, если он есть: локальный blob может быть
              единственной копией, и пользователю важно видеть, какое фото не
              ушло. Приглушаем, чтобы состояние читалось как проблемное. */}
          {localThumb && (
            <img
              src={localThumb}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: 0.45,
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: 4,
            }}
          >
            <WarningOutlined style={{ fontSize: 20, color: '#cf1322' }} />
            <Typography.Text style={{ fontSize: 11, textAlign: 'center', color: '#cf1322' }}>
              {uploadErrorText(photo.lastUploadError)}
            </Typography.Text>
            {!blocked && (
              <Tooltip title="Отправить ещё раз">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => void retryUpload()}
                  loading={retrying}
                >
                  Повторить
                </Button>
              </Tooltip>
            )}
          </div>
          {canDelete && (
            <Popconfirm
              title="Удалить фото?"
              description="Локальная копия будет удалена безвозвратно."
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

  const image = (
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
  );

  return (
    <div style={{ width: THUMB_SIZE }}>
      <div style={{ position: 'relative', width: THUMB_SIZE, height: THUMB_SIZE }}>
        {/* Подсказка — на всю миниатюру: сам значок прозрачен для мыши, иначе
            клик в его угол не открывал бы фото. Обёртка есть всегда, даже без
            отметки: появление отметки при открытом просмотре не должно
            перемонтировать Image — rc-image перерегистрировал бы кадр в
            конец группы, и просмотр перескочил бы на другое фото. */}
        <Tooltip
          title={viewedAt !== undefined ? `Просмотрено ${formatViewedAt(viewedAt)}` : undefined}
          mouseEnterDelay={0.5}
        >
          <div>{image}</div>
        </Tooltip>
        {viewedAt !== undefined && (
          <span
            aria-label="Просмотрено"
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: '#52c41a',
              color: '#fff',
              fontSize: 11,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // Белое кольцо — значок читается и на светлом листе, и на снегу.
              boxShadow: '0 0 0 2px rgba(255, 255, 255, 0.9)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          >
            <CheckOutlined />
          </span>
        )}
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
