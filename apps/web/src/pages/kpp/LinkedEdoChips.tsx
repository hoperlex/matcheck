import { useRef, useState, type MouseEvent } from 'react';
import { Button, Popconfirm, Tag, Tooltip } from 'antd';
import { edoOperatorLabel } from '../shared/edoOperator';
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
  /** Документ приёмки, к блоку которого привязана УПД; null — к приёмке целиком. */
  sectionDocumentId: string | null;
  /** Другие приёмки с той же УПД: первые по номеру и общее число. */
  alsoIn: { deliveryId: string; displayId: number }[];
  alsoInCount: number;
  /** Оператор ЭДО ('diadoc' | 'sbis'); у прежнего ответа поля нет. */
  operator?: string;
};

/** Сколько номеров других приёмок писать прямо в чипе; остальные — в подсказке. */
const ALSO_IN_INLINE = 2;

/** «21041, 21070 и ещё 3» — номера других приёмок с той же УПД. */
export function deliveryNumbersText(
  deliveries: readonly { displayId: number }[],
  total: number,
  inline: number = deliveries.length,
): string {
  const shown = deliveries.slice(0, inline).map((d) => d.displayId);
  const rest = total - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

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
          ЭДО{document.operator ? ` · ${edoOperatorLabel(document.operator)}` : ''}:{' '}
          {document.docNumber ?? 'без номера'}
          {document.docDate ? ` от ${document.docDate}` : ''}
          {document.source === 'export' ? ' · XML' : ''}
          {document.alsoInCount > 0 && (
            <Tooltip
              title={`Та же УПД в приёмках: ${deliveryNumbersText(document.alsoIn, document.alsoInCount)}`}
            >
              <span>
                {' · ещё в '}
                {deliveryNumbersText(document.alsoIn, document.alsoInCount, ALSO_IN_INLINE)}
              </span>
            </Tooltip>
          )}
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
