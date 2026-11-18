import { Typography } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useViewedPhotos } from '../../lib/photoViewed';

/**
 * «· просмотрено 2 из 3» у заголовка этапа фото. Пока не открыто ни одно —
 * не показываем ничего: на каждой свежей приёмке «0 из N» было бы шумом.
 * Считаются только фото, подтверждённые сервером, — у загружающихся ещё
 * локальный id, и отметки у них не бывает (см. PhotoGallery).
 */
export function PhotoViewedCounter({
  photos,
  small = false,
}: {
  photos: ReadonlyArray<{ id: string; uploadedAt: string | null }>;
  /** Мелкий шрифт — под мелкие подписи этапов (окно просмотра приёмки). */
  small?: boolean;
}): JSX.Element | null {
  const viewed = useViewedPhotos();
  const countable = photos.filter((p) => p.uploadedAt !== null);
  const seen = countable.filter((p) => viewed[p.id] !== undefined).length;
  if (seen === 0) return null;
  const fontSize = small ? 12 : undefined;
  if (seen === countable.length) {
    return (
      <Typography.Text style={{ marginInlineStart: 8, color: '#389e0d', fontSize }}>
        <CheckOutlined /> все просмотрены
      </Typography.Text>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ marginInlineStart: 8, fontSize }}>
      · просмотрено {seen} из {countable.length}
    </Typography.Text>
  );
}
