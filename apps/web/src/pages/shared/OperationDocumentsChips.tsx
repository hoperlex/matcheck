import { Button, Popconfirm, Popover, Space, Tag, Typography } from 'antd';
import { DisconnectOutlined } from '@ant-design/icons';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import {
  groupDocumentsByKind,
  summarizeDates,
  sumDocumentTotals,
} from '../../shared/utils/operationDocumentsSummary';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';

/**
 * Чипы документов в шапке операции.
 *
 * Показываются ТОЛЬКО связанные документы: позиции после отвязки сохраняют
 * происхождение (их блок в материалах остаётся), но в шапке отвязанного
 * документа быть не должно — иначе «Отвязать» выглядит не сработавшим.
 *
 * Раньше здесь стоял один документ — `sourceDocumentIds[0]`, и у приёмки из
 * четырёх УПД в шапке был номер одной бумаги, а «Сумма» показывала её итог
 * вместо итога поставки.
 */

/** Сколько номеров показываем в чипе до того, как свернуть остальные в «+N». */
const INLINE_NUMBERS = 3;

function docLabel(doc: OperationSourceDocument): string {
  return doc.docNumber ?? '— без номера —';
}

export function OperationDocumentsChips({
  documents,
  onUnlink,
  unlinkPending = false,
}: {
  /** Связанные документы операции. */
  documents: OperationSourceDocument[];
  /** undefined — прав на отвязку нет, кнопки не будет. */
  onUnlink?: (document: OperationSourceDocument) => void;
  unlinkPending?: boolean;
}) {
  if (documents.length === 0) return null;

  const docDate = summarizeDates(documents, 'docDate');
  const expectedDate = summarizeDates(documents, 'expectedDate');
  const money = sumDocumentTotals(documents);
  const partial = (known: number, total: number) =>
    known < total ? ` · у ${known} из ${total}` : '';

  const details = (
    <Space direction="vertical" size={4} style={{ maxWidth: 420 }}>
      {documents.map((doc) => (
        <Space key={doc.id} size={8} wrap>
          <Typography.Text strong style={{ fontSize: 12 }}>
            {sourceKindLabel(doc.kind)} {docLabel(doc)}
          </Typography.Text>
          {doc.docDate && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {doc.docDate}
            </Typography.Text>
          )}
          {doc.totalSum && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatMoneyRu(doc.totalSum)}
            </Typography.Text>
          )}
          {onUnlink && (
            <Popconfirm
              title="Отвязать документ?"
              description="Материалы останутся в приёмке, документ вернётся в список свободных."
              okText="Отвязать"
              cancelText="Отмена"
              onConfirm={() => onUnlink(doc)}
            >
              <Button
                type="link"
                size="small"
                danger
                icon={<DisconnectOutlined />}
                disabled={unlinkPending}
                style={{ padding: '0 4px', fontSize: 12 }}
              >
                Отвязать
              </Button>
            </Popconfirm>
          )}
        </Space>
      ))}
    </Space>
  );

  return (
    <>
      {groupDocumentsByKind(documents).map((group) => {
        const numbers = group.documents.map(docLabel);
        const shown = numbers.slice(0, INLINE_NUMBERS).join(', ');
        const restCount = numbers.length - INLINE_NUMBERS;
        return (
          <Popover key={group.kindLabel} content={details} trigger="click" placement="bottomLeft">
            <Tag color="blue" style={{ marginInlineEnd: 0, cursor: 'pointer' }}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {group.kindLabel}:
              </Typography.Text>{' '}
              <Typography.Text strong style={{ fontSize: 12 }}>
                {shown}
                {restCount > 0 ? ` +${restCount}` : ''}
              </Typography.Text>
            </Tag>
          </Popover>
        );
      })}
      {docDate && (
        <Tag style={{ marginInlineEnd: 0 }}>
          Дата документа: {docDate.text}
          {partial(docDate.known, docDate.total)}
        </Tag>
      )}
      {expectedDate && (
        <Tag style={{ marginInlineEnd: 0 }}>
          Дата поставки: {expectedDate.text}
          {partial(expectedDate.known, expectedDate.total)}
        </Tag>
      )}
      {money && (
        <Tag style={{ marginInlineEnd: 0 }}>
          {documents.length > 1 ? 'Сумма по документам' : 'Сумма'}: {formatMoneyRu(money.total)}
          {money.known < money.count ? ` · сумма указана у ${money.known} из ${money.count}` : ''}
        </Tag>
      )}
    </>
  );
}
