import { useState } from 'react';
import { Button, Checkbox, Popconfirm, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import { DisconnectOutlined, EyeOutlined, WarningOutlined } from '@ant-design/icons';
import type { EdoSummary, OperationSourceDocument } from '@matcheck/contracts';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import {
  edoDateSources,
  edoHeaderSumHint,
  edoHeaderSumLabel,
  edoScanMismatch,
  sharedEdoText,
  unpairedScanDocuments,
} from '../../shared/utils/edoSummaryView';
import {
  groupDocumentsByKind,
  summarizeDates,
  sumDocumentTotals,
} from '../../shared/utils/operationDocumentsSummary';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';

/**
 * Чипы документов в шапке операции.
 *
 * Показываются ТОЛЬКО связанные документы: позиции, оставленные при отвязке,
 * сохраняют происхождение (их блок в материалах остаётся), но в шапке
 * отвязанного документа быть не должно — иначе «Отвязать» выглядит не
 * сработавшим.
 *
 * Раньше здесь стоял один документ — `sourceDocumentIds[0]`, и у приёмки из
 * четырёх УПД в шапке был номер одной бумаги, а «Сумма» показывала её итог
 * вместо итога поставки.
 *
 * С УПД из ЭДО (`edoSummary`) номер, дата и сумма — по ЭДО: бумага, у которой
 * есть пара в ЭДО, из чипов уходит (остаётся в поповере с «Отвязать»), а
 * расхождение итога со сканом видно отдельной пометкой.
 */

/** Сколько номеров показываем в чипе до того, как свернуть остальные в «+N». */
const INLINE_NUMBERS = 3;

/** Ключ поповера чипа «УПД из ЭДО» — не совпадает ни с одной подписью вида. */
const EDO_GROUP = '__edo__';

function docLabel(doc: OperationSourceDocument): string {
  return doc.docNumber ?? '— без номера —';
}

/** Выбор человека в окне «Отвязать документ?». */
export type UnlinkOptions = {
  /** Удалить вместе со связью все строки блока документа. */
  deleteItems: boolean;
};

export function OperationDocumentsChips({
  documents,
  onUnlink,
  itemCountByDocumentId,
  onOpenOriginal,
  unlinkPending = false,
  edoSummary,
}: {
  /** Связанные документы операции. */
  documents: OperationSourceDocument[];
  /** undefined — прав на отвязку нет, кнопки не будет. */
  onUnlink?: (document: OperationSourceDocument, options: UnlinkOptions) => void;
  /**
   * Сколько строк в блоке каждого документа — по форме карточки, то есть ровно
   * то, что человек видит. Без строк галочки «удалить» в окне отвязки нет.
   */
  itemCountByDocumentId?: ReadonlyMap<string, number>;
  /**
   * Открыть оригинал документа. undefined — номер остаётся обычным текстом
   * (карточки в режиме просмотра и отгрузка пока без этой возможности).
   */
  onOpenOriginal?: (document: OperationSourceDocument) => void;
  unlinkPending?: boolean;
  /** УПД из ЭДО приёмки (DTO `edoSummary`); нет — шапка по документам скана. */
  edoSummary?: EdoSummary;
}) {
  // Какой поповер раскрыт. Состояние на ГРУППУ, а не общий флаг: чипов
  // столько, сколько видов документов, и один boolean раскрыл бы поповеры
  // УПД и накладной разом.
  //
  // Хук объявлен до раннего return ниже: иначе появление первого документа
  // меняло бы число хуков между рендерами («Rendered more hooks than during
  // the previous render»).
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Галочка «удалить строки блока». Одна на компонент: окно подтверждения
  // открыто всегда одно, и при каждом открытии она снова включена — выбор
  // прошлой отвязки на следующую не переносится.
  const [deleteItems, setDeleteItems] = useState(true);

  if (documents.length === 0 && !edoSummary) return null;

  const unlinkDescription = (count: number) =>
    count > 0 ? (
      <Space direction="vertical" size={4} style={{ maxWidth: 300 }}>
        <span>Документ вернётся в список свободных.</span>
        <Checkbox checked={deleteItems} onChange={(e) => setDeleteItems(e.target.checked)}>
          Удалить все строки его блока ({count}), в том числе добавленные вручную
        </Checkbox>
      </Space>
    ) : (
      'Документ вернётся в список свободных.'
    );

  // С ЭДО чипы номеров — по УПД из ЭДО и бумагам без пары; поповер со всеми
  // бумагами и «Отвязать» остаётся прежним.
  const chipDocuments = edoSummary ? unpairedScanDocuments(edoSummary, documents) : documents;
  const docDate = summarizeDates(
    edoSummary ? edoDateSources(edoSummary, documents) : documents,
    'docDate',
  );
  const expectedDate = summarizeDates(documents, 'expectedDate');
  const money = edoSummary
    ? edoSummary.header.total === null
      ? null
      : {
          total: edoSummary.header.total,
          known: edoSummary.header.known,
          count: edoSummary.header.count,
        }
    : sumDocumentTotals(documents);
  const mismatch = edoSummary ? edoScanMismatch(edoSummary) : null;
  const shared = edoSummary ? sharedEdoText(edoSummary) : null;
  const partial = (known: number, total: number) =>
    known < total ? ` · у ${known} из ${total}` : '';

  const details = (
    <Space direction="vertical" size={4} style={{ maxWidth: 420 }}>
      {documents.map((doc) => (
        <Space key={doc.id} size={8} wrap>
          {onOpenOriginal ? (
            // Открывает сам номер: менеджер тянется к нему, а не к
            // отдельной кнопке. Иконка глаза показывает, что строка
            // кликается. «Отвязать» остаётся отдельной красной кнопкой —
            // разрушительное действие не должно делить клик с просмотром.
            <Typography.Link
              style={{ fontSize: 12 }}
              onClick={() => {
                setOpenGroup(null);
                onOpenOriginal(doc);
              }}
            >
              <EyeOutlined style={{ marginInlineEnd: 4 }} />
              <Typography.Text strong style={{ fontSize: 12, color: 'inherit' }}>
                {sourceKindLabel(doc.kind)} {docLabel(doc)}
              </Typography.Text>
            </Typography.Link>
          ) : (
            <Typography.Text strong style={{ fontSize: 12 }}>
              {sourceKindLabel(doc.kind)} {docLabel(doc)}
            </Typography.Text>
          )}
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
              description={unlinkDescription(itemCountByDocumentId?.get(doc.id) ?? 0)}
              okText="Отвязать"
              cancelText="Отмена"
              onOpenChange={(open) => {
                if (open) setDeleteItems(true);
              }}
              onConfirm={() =>
                onUnlink(doc, {
                  deleteItems: deleteItems && (itemCountByDocumentId?.get(doc.id) ?? 0) > 0,
                })
              }
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

  const edoNumbers = edoSummary?.documents.map((doc) => doc.docNumber ?? 'без номера') ?? [];
  const edoChip = edoSummary && (
    <Tag
      color="blue"
      style={{ marginInlineEnd: 0, cursor: documents.length ? 'pointer' : 'default' }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        УПД из ЭДО:
      </Typography.Text>{' '}
      <Typography.Text strong style={{ fontSize: 12 }}>
        {edoNumbers.slice(0, INLINE_NUMBERS).join(', ')}
        {edoNumbers.length > INLINE_NUMBERS ? ` +${edoNumbers.length - INLINE_NUMBERS}` : ''}
      </Typography.Text>
    </Tag>
  );

  return (
    <>
      {edoChip &&
        (documents.length > 0 ? (
          <Popover
            content={details}
            trigger="click"
            placement="bottomLeft"
            open={openGroup === EDO_GROUP}
            onOpenChange={(visible) => setOpenGroup(visible ? EDO_GROUP : null)}
          >
            {edoChip}
          </Popover>
        ) : (
          edoChip
        ))}
      {groupDocumentsByKind(chipDocuments).map((group) => {
        const numbers = group.documents.map(docLabel);
        const shown = numbers.slice(0, INLINE_NUMBERS).join(', ');
        const restCount = numbers.length - INLINE_NUMBERS;
        return (
          <Popover
            key={group.kindLabel}
            content={details}
            trigger="click"
            placement="bottomLeft"
            open={openGroup === group.kindLabel}
            onOpenChange={(visible) => setOpenGroup(visible ? group.kindLabel : null)}
          >
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
      {money && !edoSummary && (
        <Tag style={{ marginInlineEnd: 0 }}>
          {documents.length > 1 ? 'Сумма по документам' : 'Сумма'}: {formatMoneyRu(money.total)}
          {money.known < money.count ? ` · сумма указана у ${money.known} из ${money.count}` : ''}
        </Tag>
      )}
      {money && edoSummary && (
        <Tooltip title={edoHeaderSumHint(edoSummary)}>
          <Tag style={{ marginInlineEnd: 0 }} color={edoSummary.ambiguous ? 'warning' : undefined}>
            {edoSummary.ambiguous && <WarningOutlined style={{ marginInlineEnd: 4 }} />}
            {edoHeaderSumLabel(edoSummary)}: {formatMoneyRu(money.total)}
            {money.known < money.count ? ` · сумма указана у ${money.known} из ${money.count}` : ''}
            {shared ? ` · ${shared}` : ''}
          </Tag>
        </Tooltip>
      )}
      {mismatch && (
        <Tooltip title={mismatch.hint}>
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            <WarningOutlined style={{ marginInlineEnd: 4 }} />
            {mismatch.text}
          </Tag>
        </Tooltip>
      )}
    </>
  );
}
