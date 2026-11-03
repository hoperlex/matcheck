import { useEffect, useState } from 'react';
import { Select, Space, Typography } from 'antd';
import type { Delivery } from '@matcheck/contracts';
import { LinkEdoDocumentModal } from './LinkEdoDocumentModal';
import { ShareEdoModal, type ShareEdoDocument } from './ShareEdoModal';

/** Эталон подбора по умолчанию: первая отмеченная приёмка с документом, иначе первая. */
export function defaultAnchor(deliveries: readonly Delivery[]): string | null {
  return (deliveries.find((d) => d.sourceDocumentIds.length > 0) ?? deliveries[0])?.id ?? null;
}

/** «к 3 выбранным», «к 1 выбранной». */
function toSelected(n: number): string {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'выбранной приёмке' : 'выбранным приёмкам'}`;
}

/**
 * «Привязать УПД из ЭДО» из списка: одна УПД — к отмеченным приёмкам одного
 * объекта.
 *
 * Шаг 1 — обычное окно подбора по одной из отмеченных приёмок (эталон сверки:
 * у приёмки без документа подбору не за что зацепиться, поэтому эталон можно
 * сменить). Шаг 2 — окно «К другим приёмкам»: отмеченные приёмки уже выбраны,
 * там же снимают отметки, добавляют другие и выбирают блоки.
 */
export function BulkEdoLinkFlow({
  open,
  deliveries,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Отмеченные приёмки — строки списка (объект у всех один, проверяет вызывающий). */
  deliveries: readonly Delivery[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<'pick' | 'share'>('pick');
  const [anchorId, setAnchorId] = useState<string | null>(() => defaultAnchor(deliveries));
  const [picked, setPicked] = useState<ShareEdoDocument | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('pick');
    setPicked(null);
    setAnchorId(defaultAnchor(deliveries));
    // Состав выбора меняется только между открытиями.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const anchor = deliveries.find((d) => d.id === anchorId) ?? null;

  return (
    <>
      <LinkEdoDocumentModal
        open={open && step === 'pick'}
        deliveryId={anchor?.id ?? null}
        busy={false}
        error={null}
        deliveryItems={anchor?.items ?? []}
        deliveryPhotos={anchor?.photos ?? []}
        headerExtra={
          <Space wrap>
            <Typography.Text>Подбор по приёмке</Typography.Text>
            <Select
              size="small"
              style={{ minWidth: 260 }}
              aria-label="Приёмка для подбора"
              value={anchor?.id}
              onChange={(value: string) => setAnchorId(value)}
              options={deliveries.map((d) => ({
                value: d.id,
                label: `${d.displayId}${d.vehiclePlate ? ` · ${d.vehiclePlate}` : ''}${
                  d.sourceDocumentIds.length ? '' : ' · без документа'
                }`,
              }))}
            />
            <Typography.Text type="secondary">
              {`УПД будет привязана к ${toSelected(deliveries.length)} — на следующем шаге можно снять отметки и выбрать блоки`}
            </Typography.Text>
          </Space>
        }
        onCancel={onClose}
        onPick={(candidate) => {
          setPicked({
            source: candidate.source,
            id: candidate.id,
            docNumber: candidate.docNumber,
            docDate: candidate.docDate,
            operator: candidate.operator,
          });
          setStep('share');
        }}
      />
      <ShareEdoModal
        open={open && step === 'share'}
        anchorDeliveryId={anchor?.id ?? null}
        document={picked}
        preselected={deliveries.map((d) => d.id)}
        onCancel={onClose}
        onDone={onDone}
      />
    </>
  );
}
