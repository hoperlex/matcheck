import { useEffect, useState } from 'react';
import { Button, Image, Popconfirm, Spin, Typography, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryPhoto,
  PhotoDeleteResponse,
  PhotoGetUrlResponse,
  ShipmentPhoto,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { db, type OperationKind } from '../../lib/db';
import { useAuthStore } from '../../stores/auth';

const THUMB_SIZE = 140;
// React-query staleTime для presigned URL. Сервер выдаёт URL с TTL 15 мин
// (см. apps/api/src/routes/photos.ts URL_TTL). Обновляем за 2 мин до
// истечения — оставляем запас на сетевые задержки и дрейф часов между
// клиентом и сервером.
const URL_STALE = 13 * 60 * 1000;

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
  const canDelete = useAuthStore((s) => s.user?.role === 'admin') && !readOnly;
  const queryClient = useQueryClient();
  const invalidateKey = operationKind === 'shipment' ? 'shipments' : 'deliveries';

  const del = useMutation<PhotoDeleteResponse, Error, string>({
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
    onError: (err: Error) => message.error(err.message),
  });

  if (photos.length === 0) return null;

  const sorted = [...photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt));

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, ${THUMB_SIZE}px)`,
        gap: 8,
        width: '100%',
      }}
    >
      <Image.PreviewGroup>
        {sorted.map((p) => (
          <PhotoThumb
            key={p.id}
            photo={p}
            canDelete={canDelete}
            onDelete={() => del.mutate(p.id)}
            deleting={del.isPending && del.variables === p.id}
          />
        ))}
      </Image.PreviewGroup>
    </div>
  );
}

function PhotoThumb({
  photo,
  canDelete,
  onDelete,
  deleting,
}: {
  photo: AnyPhoto;
  canDelete: boolean;
  onDelete: () => void;
  deleting: boolean;
}): JSX.Element {
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
  const thumbQuery = useQuery({
    queryKey: ['photo-url', photo.id, 'thumb'],
    queryFn: () => api.get<PhotoGetUrlResponse>(`/photos/${photo.id}/url?thumb=true`),
    enabled: needsRemote,
    staleTime: URL_STALE,
  });
  const fullQuery = useQuery({
    queryKey: ['photo-url', photo.id, 'full'],
    queryFn: () => api.get<PhotoGetUrlResponse>(`/photos/${photo.id}/url`),
    enabled: needsRemote,
    staleTime: URL_STALE,
  });

  const thumbSrc = localThumb ?? thumbQuery.data?.url ?? '';
  const fullSrc = localFull ?? fullQuery.data?.url ?? thumbSrc;

  if (isUploading) {
    return (
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
    );
  }

  return (
    <div style={{ position: 'relative', width: THUMB_SIZE, height: THUMB_SIZE }}>
      <Image
        src={thumbSrc}
        preview={{ src: fullSrc }}
        width={THUMB_SIZE}
        height={THUMB_SIZE}
        style={{ objectFit: 'cover', borderRadius: 6 }}
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
  );
}
