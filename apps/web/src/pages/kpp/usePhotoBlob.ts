import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiDownload } from '../../services/api';
import { enqueueFullLoad, enqueueThumbLoad } from '../../lib/thumbQueue';

/**
 * Blob фото приёмки через API-прокси.
 *
 * Ключи кэша и очереди — те же, что у PhotoGallery: фото, уже открытое в
 * галерее карточки, второй раз не качается, и наоборот. Фото неизменяемо,
 * поэтому staleTime бесконечный. Очередь ограничивает параллельные загрузки:
 * у большинства фото миниатюры нет, и `?thumb=true` отдаёт оригинал.
 */
export function usePhotoBlob(photoId: string, variant: 'thumb' | 'full', enabled = true) {
  const query = useQuery({
    queryKey: ['photo-blob', photoId, variant],
    queryFn: () =>
      (variant === 'thumb' ? enqueueThumbLoad : enqueueFullLoad)(async () => {
        const suffix = variant === 'thumb' ? '?thumb=true' : '';
        const { blob } = await apiDownload(`/photos/${photoId}/content${suffix}`);
        return blob;
      }),
    enabled,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    refetchOnWindowFocus: false,
  });
  const url = useObjectUrl(query.data ?? null);
  return { blob: query.data ?? null, url, isError: query.isError, refetch: query.refetch };
}

/**
 * Object URL для blob. Живёт, пока смонтирован компонент, и отзывается при
 * смене blob: без revoke браузер держит данные до выгрузки страницы.
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/**
 * HEIC/HEIF браузер не покажет. MIME в данных фото нет, поэтому смотрим тип
 * пришедшего ответа (сервер берёт его из S3 или по расширению); прочие
 * нечитаемые форматы ловит onError у картинки.
 */
export function isUnsupportedImage(blob: Blob | null): boolean {
  return !!blob && /^image\/hei[cf]/i.test(blob.type);
}
