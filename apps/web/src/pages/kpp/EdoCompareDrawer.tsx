import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Drawer, Empty, Image, Segmented, Space, Spin, Typography } from 'antd';
import type { DeliveryPhoto } from '@matcheck/contracts';
import { ApiError, apiDownload, saveBlobAsFile } from '../../services/api';
import { formatDateRu, formatDateTimeRu } from '../../shared/utils/formatRu';
import { isUnsupportedImage, useObjectUrl, usePhotoBlob } from './usePhotoBlob';

export type CompareCandidate = {
  id: string;
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
};

export type ComparePhoto = Pick<DeliveryPhoto, 'id' | 'kind' | 'stage' | 'takenAt' | 'uploadedAt'>;

const PANE_MIN_HEIGHT = 480;

function stageLabel(stage: ComparePhoto['stage']): string {
  return stage === 'after' ? '2 Этап' : '1 Этап';
}

/** Как в PhotoGallery: «прочее» не подписываем. */
function kindLabel(kind: ComparePhoto['kind']): string | null {
  if (kind === 'document') return 'Документ';
  if (kind === 'cargo' || kind === 'vehicle') return 'Груз/машина';
  return null;
}

function photoFilename(photo: ComparePhoto, blob: Blob): string {
  const ext = /hei[cf]/i.test(blob.type) ? 'heic' : (blob.type.split('/')[1] ?? 'jpg');
  return `photo-${photo.id}.${ext}`;
}

/** PDF-представление УПД: строится на сервере из XML реестра ЭДО. */
function PdfPane({
  deliveryId,
  candidate,
  onOpenXml,
}: {
  deliveryId: string;
  candidate: CompareCandidate;
  onOpenXml: () => void;
}) {
  const pdf = useQuery({
    queryKey: ['edo-candidate-pdf', deliveryId, candidate.id],
    queryFn: async () => {
      const { blob } = await apiDownload(
        `/deliveries/${deliveryId}/edo-candidates/export/${candidate.id}/pdf`,
      );
      if (!blob.type.startsWith('application/pdf')) {
        throw new Error('Сервер вернул не PDF — откройте XML');
      }
      return blob;
    },
    staleTime: 10 * 60_000,
    gcTime: 10 * 60_000,
    // Отказы сервера осмысленные (слишком большой, не разобрался) — повтор
    // по кнопке, а не автоматом.
    retry: false,
    refetchOnWindowFocus: false,
  });
  const url = useObjectUrl(pdf.data ?? null);

  if (pdf.isError) {
    // apiDownload не доносит код ошибки, только статус и текст сервера.
    const retryable = pdf.error instanceof ApiError && [0, 502, 503].includes(pdf.error.status);
    return (
      <Alert
        type="error"
        showIcon
        message={pdf.error instanceof Error ? pdf.error.message : 'Не удалось построить PDF'}
        description="Источник правды — XML документа: его можно открыть в новой вкладке."
        action={
          <Space direction="vertical">
            {retryable && (
              <Button size="small" onClick={() => void pdf.refetch()}>
                Повторить
              </Button>
            )}
            <Button size="small" onClick={onOpenXml}>
              Открыть XML
            </Button>
          </Space>
        }
      />
    );
  }
  if (!url) {
    return (
      <Space style={{ margin: 'auto' }}>
        <Spin />
        <Typography.Text type="secondary">Строим PDF…</Typography.Text>
      </Space>
    );
  }
  return (
    <iframe
      title={`УПД ${candidate.docNumber ?? 'без номера'}`}
      src={`${url}#toolbar=1&navpanes=0`}
      style={{ flex: '1 1 auto', width: '100%', border: 0, minHeight: PANE_MIN_HEIGHT }}
    />
  );
}

function MainPhoto({
  photo,
  label,
  onPreviewClosed,
}: {
  photo: ComparePhoto;
  label: string | null;
  onPreviewClosed: () => void;
}) {
  const { blob, url, isError, refetch } = usePhotoBlob(photo.id, 'full');
  const [broken, setBroken] = useState(false);
  const caption = [stageLabel(photo.stage), formatDateTimeRu(photo.takenAt), label]
    .filter(Boolean)
    .join(' · ');

  let body: ReactNode;
  if (isError) {
    body = (
      <Alert
        type="error"
        showIcon
        message="Не удалось загрузить фото"
        action={
          <Button size="small" onClick={() => void refetch()}>
            Повторить
          </Button>
        }
      />
    );
  } else if (!blob || !url) {
    body = <Spin />;
  } else if (broken || isUnsupportedImage(blob)) {
    body = (
      <Alert
        type="warning"
        showIcon
        message="Не удалось показать изображение"
        description={
          isUnsupportedImage(blob)
            ? 'Формат HEIC браузер не показывает — скачайте файл.'
            : 'Браузер не смог открыть этот файл — скачайте его.'
        }
        action={
          <Button size="small" onClick={() => saveBlobAsFile(blob, photoFilename(photo, blob))}>
            Скачать
          </Button>
        }
      />
    );
  } else {
    body = (
      <Image
        src={url}
        alt={caption}
        style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 280px)', objectFit: 'contain' }}
        onError={() => setBroken(true)}
        preview={{
          src: url,
          // Просмотр — диалог поверх панели. Картинка не фокусируется, и после
          // закрытия фокус уходил бы на body: ESC перестал бы закрывать панель.
          afterOpenChange: (open: boolean) => {
            if (!open) onPreviewClosed();
          },
        }}
      />
    );
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 auto', minHeight: 0 }}
    >
      <Typography.Text type="secondary">{caption}</Typography.Text>
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 240,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fafafa',
          borderRadius: 6,
          overflow: 'auto',
          padding: 8,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function ThumbButton({
  photo,
  index,
  selected,
  onSelect,
}: {
  photo: ComparePhoto;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { blob, url } = usePhotoBlob(photo.id, 'thumb');
  const unsupported = isUnsupportedImage(blob);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Фото ${index}`}
      aria-pressed={selected}
      style={{
        flex: '0 0 auto',
        width: 64,
        height: 64,
        padding: 0,
        border: selected ? '2px solid #1677ff' : '1px solid #d9d9d9',
        borderRadius: 6,
        background: '#fafafa',
        cursor: 'pointer',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url && !unsupported ? (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {unsupported ? 'HEIC' : index}
        </Typography.Text>
      )}
    </button>
  );
}

/**
 * Фото приёмки для сверки. По умолчанию — фото с типом «Документ»; если таких
 * нет, показываем все: у старых записей тип мог не проставиться, и пустой
 * список утверждал бы больше, чем мы знаем.
 */
function PhotosPane({
  photos,
  onPreviewClosed,
}: {
  photos: readonly ComparePhoto[];
  onPreviewClosed: () => void;
}) {
  const sorted = useMemo(
    () =>
      photos
        .filter((p) => p.uploadedAt !== null)
        .sort(
          (a, b) =>
            Number(a.stage === 'after') - Number(b.stage === 'after') ||
            a.takenAt.localeCompare(b.takenAt),
        ),
    [photos],
  );
  const documents = useMemo(() => sorted.filter((p) => p.kind === 'document'), [sorted]);
  const [mode, setMode] = useState<'documents' | 'all'>('documents');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (sorted.length === 0) {
    return <Empty description="У приёмки нет загруженных фото" />;
  }
  const shown = mode === 'documents' && documents.length > 0 ? documents : sorted;
  const selected = shown.find((p) => p.id === selectedId) ?? shown[0]!;
  // Подписи типа — только когда тип проставлен осмысленно (см. PhotoGallery):
  // если все фото «Груз/машина» по умолчанию, тип мы достоверно не знаем.
  const showKindLabels = sorted.some((p) => p.kind === 'document' || p.kind === 'vehicle');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      {documents.length > 0 && documents.length < sorted.length && (
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as 'documents' | 'all')}
          options={[
            { label: `Документы (${documents.length})`, value: 'documents' },
            { label: `Все фото (${sorted.length})`, value: 'all' },
          ]}
        />
      )}
      {documents.length === 0 && (
        <Alert
          type="info"
          showIcon
          message="Фото с типом «Документ» нет — показаны все фото приёмки."
          description="У старых записей тип фото мог не проставиться."
        />
      )}
      <MainPhoto
        key={selected.id}
        photo={selected}
        label={showKindLabels ? kindLabel(selected.kind) : null}
        onPreviewClosed={onPreviewClosed}
      />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
        {shown.map((p, i) => (
          <ThumbButton
            key={p.id}
            photo={p}
            index={i + 1}
            selected={p.id === selected.id}
            onSelect={() => setSelectedId(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Панель сверки УПД из ЭДО с бумагой: слева PDF-представление документа,
 * справа фото приёмки. Без кандидата — только фото.
 *
 * Drawer, а не Modal: вложенная Modal ломает ESC окна подбора. Возврат фокуса
 * во внешнее окно — забота вызывающего (`afterClose`): панель живёт в
 * портале и сама до него не дотянется.
 *
 * Только просмотр: ни привязки, ни правки фото здесь нет.
 */
export function EdoCompareDrawer({
  open,
  deliveryId,
  candidate,
  photos,
  onClose,
  afterClose,
  onOpenXml,
}: {
  open: boolean;
  deliveryId: string | null;
  candidate: CompareCandidate | null;
  photos: readonly ComparePhoto[];
  onClose: () => void;
  afterClose: () => void;
  onOpenXml: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const title = candidate
    ? [
        `УПД ${candidate.docNumber ?? 'без номера'}`,
        candidate.docDate ? `от ${formatDateRu(candidate.docDate)}` : null,
        candidate.supplierName ? `· ${candidate.supplierName}` : null,
      ]
        .filter(Boolean)
        .join(' ')
    : 'Фото приёмки';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      afterOpenChange={(next) => {
        if (!next) afterClose();
      }}
      title={title}
      width="min(1200px, 96vw)"
      destroyOnHidden
      styles={{ body: { padding: 12 } }}
      extra={
        candidate && (
          <Button size="small" onClick={onOpenXml}>
            Открыть XML
          </Button>
        )
      }
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, minHeight: '100%', outline: 'none' }}
      >
        {candidate && deliveryId && (
          <section
            aria-label="PDF УПД"
            style={{
              flex: '1 1 560px',
              minWidth: 0,
              minHeight: PANE_MIN_HEIGHT,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <PdfPane deliveryId={deliveryId} candidate={candidate} onOpenXml={onOpenXml} />
          </section>
        )}
        <section
          aria-label="Фото приёмки"
          style={{
            flex: candidate ? '1 1 420px' : '1 1 100%',
            minWidth: 0,
            minHeight: PANE_MIN_HEIGHT,
          }}
        >
          <PhotosPane
            photos={photos}
            onPreviewClosed={() => panelRef.current?.focus({ preventScroll: true })}
          />
        </section>
      </div>
    </Drawer>
  );
}
