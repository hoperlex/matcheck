import { Empty, Modal, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { Delivery, Shipment } from '@matcheck/contracts';
import { api } from '../../services/api';
import { PhotoGallery } from '../kpp/PhotoGallery';

/**
 * Лёгкая модалка «Фото материала» из Истории поступлений. Тянет detail
 * приёмки или отгрузки (там photos уже включены в DTO) и рендерит
 * PhotoGallery в readOnly-режиме (без кнопок удаления). Никаких других
 * полей — реквизитов, материалов, шапки — пользователь хотел именно
 * «только фото».
 */
export function MaterialPhotosModal({
  kind,
  id,
  open,
  onClose,
}: {
  kind: 'delivery' | 'shipment' | null;
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const enabled = open && !!id && !!kind;

  const deliveryQuery = useQuery({
    queryKey: ['materials-photos', 'delivery', id],
    queryFn: () => api.get<Delivery>(`/deliveries/${id}`),
    enabled: enabled && kind === 'delivery',
  });
  const shipmentQuery = useQuery({
    queryKey: ['materials-photos', 'shipment', id],
    queryFn: () => api.get<Shipment>(`/shipments/${id}`),
    enabled: enabled && kind === 'shipment',
  });

  const loading = kind === 'delivery' ? deliveryQuery.isLoading : shipmentQuery.isLoading;
  const photos =
    kind === 'delivery'
      ? (deliveryQuery.data?.photos ?? [])
      : (shipmentQuery.data?.photos ?? []);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Фото"
      footer={null}
      width={900}
      destroyOnClose
    >
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : photos.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              Для этой записи фото нет
            </Typography.Text>
          }
        />
      ) : id && kind ? (
        <PhotoGallery
          deliveryId={id}
          photos={photos}
          operationKind={kind}
          readOnly
        />
      ) : null}
    </Modal>
  );
}
