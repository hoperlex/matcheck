import { useEffect, useState } from 'react';
import { Button, Image, Popconfirm, Spin, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryPhoto,
  PhotoDeleteResponse,
  PhotoGetUrlResponse,
  ShipmentPhoto,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { db, type OperationKind } from '../../lib/db';
import { useAuthStore } from '../../stores/auth';

const THUMB_SIZE = 140;
const URL_STALE = 4 * 60 * 1000; // presigned URL живёт 5 минут, обновляем чуть раньше

type AnyPhoto = DeliveryPhoto | ShipmentPhoto;

export function PhotoGallery({
  deliveryId,
  photos,
  operationKind = 'delivery',
}: {
  deliveryId: string;
  photos: AnyPhoto[];
  operationKind?: OperationKind;
}): JSX.Element | null {
  const canDelete = useAuthStore((s) => s.user?.role === 'admin');
  const queryClient = useQueryClient();
  const invalidateKey = operationKind === 'shipment' ? 'shipments' : 'deliveries';

  const del = useMutation({
    mutationFn: (id: string) => api.delete<PhotoDeleteResponse>(`/photos/${id}`),
    onSuccess: async (_, id) => {
      message.success('Фото удалено');
      const dbi = await db();
      await dbi.delete('photos', id).catch(() => undefined);
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

  const needsRemote = idbChecked && !localThumb;
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
