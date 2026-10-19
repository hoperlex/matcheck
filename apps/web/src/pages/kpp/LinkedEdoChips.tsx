import { useRef, useState, type MouseEvent } from 'react';
import { Button, Popconfirm, Tag } from 'antd';
import { EdoCompareDrawer, type ComparePhoto } from './EdoCompareDrawer';

/** УПД из ЭДО, привязанная к приёмке (`GET /deliveries/:id/edo-matches`). */
export type LinkedEdoDocument = {
  id: string;
  documentId: string;
  source: 'import' | 'export';
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  totalSum: string | null;
  linkedAt: string;
};

/**
 * Чипы привязанных УПД из ЭДО в шапке приёмки.
 *
 * «Файл» у УПД из реестра выгрузки открывает ту же панель сверки, что «Открыть
 * файл» в окне подбора: PDF, построенный из XML, рядом с фото приёмки. Сырой
 * XML остаётся в шапке панели. `documentId` такой строки — id документа
 * реестра, поэтому подходит PDF-маршрут кандидатов. Для документа из импорта
 * PDF не строится — его оригинал открывается, как раньше.
 */
export function LinkedEdoChips({
  deliveryId,
  documents,
  photos,
  unlinkDisabled,
  onUnlink,
  onOpenOriginal,
}: {
  deliveryId: string | null;
  documents: readonly LinkedEdoDocument[];
  photos: readonly ComparePhoto[];
  unlinkDisabled: boolean;
  onUnlink: (document: LinkedEdoDocument) => void;
  onOpenOriginal: (document: LinkedEdoDocument) => void;
}) {
  const [compare, setCompare] = useState<LinkedEdoDocument | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  // Куда вернуть фокус после панели: в обёртку карточки-модалки, иначе
  // следующий ESC её не закроет. Панель живёт в портале, поэтому обёртку
  // ищем от нажатой кнопки, пока она ещё в карточке.
  const focusReturn = useRef<HTMLElement | null>(null);

  const openFile = (document: LinkedEdoDocument, event: MouseEvent<HTMLElement>) => {
    if (document.source !== 'export') {
      onOpenOriginal(document);
      return;
    }
    focusReturn.current = event.currentTarget.closest<HTMLElement>('.ant-modal-wrap');
    setCompare(document);
    setCompareOpen(true);
  };

  return (
    <>
      {documents.map((document) => (
        <Tag key={document.id} color="green" style={{ marginInlineEnd: 0 }}>
          ЭДО: {document.docNumber ?? 'без номера'}
          {document.docDate ? ` от ${document.docDate}` : ''}
          {document.source === 'export' ? ' · XML' : ''}
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 4 }}
            onClick={(event) => openFile(document, event)}
          >
            Файл
          </Button>
          <Popconfirm
            title="Убрать связь с УПД из ЭДО?"
            onConfirm={() => onUnlink(document)}
            okText="Убрать"
            cancelText="Отмена"
            disabled={unlinkDisabled}
          >
            <Button type="link" size="small" style={{ paddingInline: 4 }}>
              ×
            </Button>
          </Popconfirm>
        </Tag>
      ))}
      <EdoCompareDrawer
        open={compareOpen}
        deliveryId={deliveryId}
        candidate={
          compare && {
            id: compare.documentId,
            docNumber: compare.docNumber,
            docDate: compare.docDate,
            supplierName: compare.supplierName,
          }
        }
        photos={photos}
        onClose={() => setCompareOpen(false)}
        afterClose={() => {
          // Порядок важен: сначала фокус в карточку, потом очистка данных.
          focusReturn.current?.focus({ preventScroll: true });
          setCompare(null);
        }}
        onOpenXml={() => {
          if (compare) onOpenOriginal(compare);
        }}
      />
    </>
  );
}
