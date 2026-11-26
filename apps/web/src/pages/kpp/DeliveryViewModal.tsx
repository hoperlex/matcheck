import { Button, Collapse, Empty, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import type { z } from 'zod';
import type { DeliveryListResponseSchema } from '@matcheck/contracts';
import { PhotoGallery } from './PhotoGallery';
import { PhotoViewedCounter } from './PhotoViewedCounter';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { PendingDeletionTag } from '../../shared/ui/PendingDeletionTag';
import { HeaderChip, HeaderRow, OperationHeader } from '../../shared/ui/HeaderChip';
import { ClampText } from '../../shared/ui/ResponsiveTable';
import { useColumnTools, type ToolColumn } from '../../shared/ui/columnTools';
import { ReviewBadge, ReviewControls } from '../../shared/ui/ReviewControls';
import { DispatcherCheckControl } from '../../shared/ui/DispatcherCheckControl';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { OperationDocumentValidationAlert } from '../shared/OperationDocumentValidationAlert';
import { DELIVERY_PURPOSE_LABELS } from '../../shared/utils/deliveryPurpose';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';
import { DocumentRecipientChips } from './DocumentRecipientChips';
import { edoOperatorLabel } from '../shared/edoOperator';
import {
  edoHeaderSumHint,
  edoScanMismatch,
  sharedEdoText,
} from '../../shared/utils/edoSummaryView';

type Row = z.infer<typeof DeliveryListResponseSchema>['items'][number];
type Item = Row['items'][number];

export type DeliveryViewData = {
  delivery: Row;
  contractorName: string | null;
  supplierName: string | null;
  siteName: string | null;
  docNumber: string | null;
  docKindLabel: string | null;
  docTotalSum: number | null;
  /** «Сумма», «Сумма по ЭДО» или «Сумма по документам» — откуда цифра. */
  docTotalLabel?: string;
};

/**
 * Read-only модалка просмотра приёмки (кнопка 👁 в строке). Раньше была
 * Drawer'ом — переехала на Modal для визуального единообразия с
 * edit-режимом (этап 2.А): оба окна выглядят одинаково.
 *
 * В заголовке — только состояние записи (статус, проверка, пометка удаления);
 * плашки — теми же рядами, что в редакторе (OperationHeader), первым блоком.
 */
export function DeliveryViewModal({
  data,
  open,
  onClose,
  onEdit,
}: {
  data: DeliveryViewData | null;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  // Переход в редактор — по праву правки, а не по имени роли: выданный
  // администратором edit обязан открывать форму и отсюда.
  const canEdit = usePermissions().can('operations.deliveries', 'edit');
  const d = data?.delivery;
  // УПД из ЭДО: пометки расхождения со сканом и общей УПД — как в шапке карточки.
  const edoMismatch = d?.edoSummary ? edoScanMismatch(d.edoSummary) : null;
  const edoShared = d?.edoSummary ? sharedEdoText(d.edoSummary) : null;
  const before = (d?.photos ?? []).filter((p) => p.stage === 'before');
  const after = (d?.photos ?? []).filter((p) => p.stage === 'after');
  const items = d?.items ?? [];

  // Колонки read-only таблицы материалов. План/Факт — десятичные количества
  // (formatDecimal сохраняет запятую и трейлинг-нули как в БД); Цена/НДС/Сумма —
  // деньги в русском формате (formatMoneyRu даёт «1 234,56 ₽»).
  // Σ строки = qtyActual (или qtyPlanned, если факта нет) × price; null —
  // посчитать нельзя. Одна функция и для ячейки, и для сортировки.
  const rowTotal = (r: Item): number | null => {
    const qtyRaw = r.qtyActual ?? r.qtyPlanned;
    const qty = qtyRaw !== null && qtyRaw !== '' ? Number(qtyRaw) : null;
    const price = r.price !== null && r.price !== '' ? Number(r.price) : null;
    if (qty === null || price === null || !Number.isFinite(qty) || !Number.isFinite(price))
      return null;
    return qty * price;
  };
  const itemColumns: ToolColumn<Item>[] = [
    // Номер позиции — только сортировка: фильтр по номерам строк не нужен.
    { title: '№', dataIndex: 'lineNo', width: 50, tools: { filter: false } },
    {
      title: 'Название',
      dataIndex: 'nameRaw',
      // До двух строк, дальше «…» с подсказкой. Ширину таблицы держит
      // tableLayout="fixed" ниже: длинное название не растягивает её (модалка
      // 97vw, но позиции с описанием на абзац легко выходят за рамки).
      render: (v: string | null) => (v ? <ClampText text={v} /> : null),
      tools: { text: (r) => r.nameRaw },
    },
    {
      title: 'План',
      dataIndex: 'qtyPlanned',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    {
      title: 'Факт',
      dataIndex: 'qtyActual',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    // 80, а не 60: рядом с подписью теперь стрелка и воронка.
    { title: 'Ед.', dataIndex: 'unit', width: 80 },
    {
      title: 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      key: 'rowTotal',
      width: 140,
      render: (_: unknown, r: Item) => formatMoneyRu(rowTotal(r)),
      tools: { sortValue: rowTotal },
    },
  ];
  // Сортировка и фильтр в колонках: позиции приходят все, без лимита.
  const itemTools = useColumnTools<Item>({ columns: itemColumns, items, enabled: true });
  const renderItemsTable = (rows: Item[]) =>
    rows.length === 0 ? (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Нет материалов"
        style={{ margin: '12px 0' }}
      />
    ) : (
      <Table<Item>
        dataSource={rows}
        rowKey="id"
        size="small"
        pagination={false}
        columns={itemTools.columns}
        onChange={itemTools.onChange}
        showSorterTooltip={false}
        tableLayout="fixed"
      />
    );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width="97vw"
      title={
        d && data ? (
          <Space size={6} wrap style={{ fontSize: 12 }}>
            {/* Номер — как в заголовке редактора («Приёмка 21194»). */}
            <Typography.Text strong>Приёмка {d.displayId}</Typography.Text>
            <Tag style={{ marginInlineEnd: 0 }} color={d.status.color ?? 'default'}>
              {d.status.label}
            </Tag>
            <ReviewBadge state={d.reviewState} />
            <PendingDeletionTag
              at={d.pendingDeletionAt}
              byEmail={d.pendingDeletionByUserEmail}
              reason={d.pendingDeletionReason}
            />
          </Space>
        ) : (
          'Просмотр приёмки'
        )
      }
      styles={{
        header: { padding: '8px 16px' },
        // Body фикс-высоты — footer с «Закрыть/Открыть в редакторе»
        // всегда виден без скролла страницы. Внутри body — собственный
        // скролл, под содержимое.
        body: {
          padding: '12px 16px',
          maxHeight: 'calc(97vh - 120px)',
          overflow: 'auto',
        },
        footer: { padding: '8px 16px' },
        // Отключаем CSS-transition маски и обёртки модалки. Иначе при
        // destroyOnClose=true сначала синхронно unmount'ится content,
        // а маска ещё ~300мс fade-out'ится — в этот момент пустая шапка
        // модалки висит над хорошо видимой таблицей OperationsPage
        // («вспышка таблицы»). transitionDuration: 0 — маска и обёртка
        // исчезают мгновенно вместе с контентом. Открытие тоже без
        // анимации, но это менее заметно (фон тёмный сразу).
        mask: { transitionDuration: '0s' },
        wrapper: { transitionDuration: '0s' },
      }}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          {canEdit && (
            <Button type="primary" icon={<EditOutlined />} onClick={onEdit}>
              Открыть в редакторе
            </Button>
          )}
        </Space>
      }
      destroyOnClose
      // См. styles.mask/wrapper выше — transitionDuration: 0 убирает
      // «вспышку таблицы» (полупрозрачный кадр между unmount контента и
      // окончанием fade-out маски). transitionName="" отключает zoom
      // самой обёртки на всякий случай, чтобы не было люфта.
      transitionName=""
    >
      {d ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <OperationHeader style={{ marginBottom: 0 }}>
            <HeaderRow label="Приёмка">
              {data?.siteName && <HeaderChip label="Объект" value={data.siteName} />}
              {data?.contractorName && <HeaderChip label="Подрядчик" value={data.contractorName} />}
              {data?.supplierName && <HeaderChip label="Поставщик" value={data.supplierName} />}
              {d.isManual && <HeaderChip color="cyan">Ручной внос</HeaderChip>}
              {d.vehiclePlate && <HeaderChip label="Авто" value={d.vehiclePlate} />}
            </HeaderRow>
            <HeaderRow label="Документы">
              {d.sourceDocumentIds.length === 0 && !d.edoSummary && (
                <HeaderChip color="gold">Без документа</HeaderChip>
              )}
              {data?.docKindLabel && (
                <HeaderChip
                  color="blue"
                  label={data.docKindLabel}
                  value={data.docNumber ?? '— без номера —'}
                />
              )}
              {data?.docTotalSum != null && (
                <Tooltip title={d.edoSummary ? edoHeaderSumHint(d.edoSummary) : undefined}>
                  <HeaderChip
                    color={d.edoSummary?.ambiguous ? 'warning' : undefined}
                    label={data.docTotalLabel ?? 'Сумма'}
                    value={formatMoneyRu(data.docTotalSum) + (edoShared ? ` · ${edoShared}` : '')}
                  />
                </Tooltip>
              )}
              {edoMismatch && (
                <Tooltip title={edoMismatch.hint}>
                  <HeaderChip color="orange">{edoMismatch.text}</HeaderChip>
                </Tooltip>
              )}
            </HeaderRow>
            <HeaderRow label="Учёт">
              {d.purpose && (
                <HeaderChip
                  label={`Признак${d.recipientsPerDocument ? ' (общий)' : ''}`}
                  value={DELIVERY_PURPOSE_LABELS[d.purpose]}
                />
              )}
              {d.inTransit && <HeaderChip color="orange">🚚 Транзит</HeaderChip>}
              {d.isAssets && <HeaderChip color="purple">📦 ОС</HeaderChip>}
            </HeaderRow>
          </OperationHeader>
          <Space wrap>
            <Typography.Text>
              <b>Прибытие:</b>{' '}
              {d.arrivedAt
                ? `${formatDateRu(d.arrivedAt)} ${new Date(d.arrivedAt).toTimeString().slice(0, 5)}`
                : '—'}
            </Typography.Text>
            {d.driverName ? (
              <Typography.Text>
                <b>Водитель:</b> {d.driverName}
              </Typography.Text>
            ) : null}
            {d.confirmedByMolAt ? (
              <Typography.Text>
                <b>Подтверждение МОЛ:</b>{' '}
                {`${formatDateRu(d.confirmedByMolAt)} ${new Date(d.confirmedByMolAt)
                  .toTimeString()
                  .slice(0, 5)}`}
                {d.confirmedByMolUserEmail ? ` (${d.confirmedByMolUserEmail})` : ''}
              </Typography.Text>
            ) : null}
          </Space>

          <Space wrap size={[16, 4]} align="start">
            <ReviewControls
              entityType="delivery"
              id={d.id}
              statusCode={d.status.code}
              reviewState={d.reviewState}
              reviewNote={d.reviewNote}
              reviewedByUserEmail={d.reviewedByUserEmail}
              reviewedAt={d.reviewedAt}
              updatedAt={d.updatedAt}
              pendingDeletion={d.pendingDeletionAt != null}
            />
            <DispatcherCheckControl
              id={d.id}
              statusCode={d.status.code}
              checkedAt={d.dispatcherCheckedAt}
              checkedByUserEmail={d.dispatcherCheckedByUserEmail}
              pendingDeletion={d.pendingDeletionAt != null}
            />
          </Space>

          {/* Сверка документа — здесь же, а не только в полной карточке:
              мониторинг чаще всего открывает именно просмотр, а раздела
              «Документы» у его роли нет вовсе. */}
          <OperationDocumentValidationAlert documents={d.sourceDocuments ?? []} />

          <Collapse
            // По умолчанию фото раскрыты — основной контент просмотра.
            // Если у приёмки много материалов с длинными названиями,
            // пользователь сворачивает фото одним кликом, чтобы быстрее
            // листать таблицу.
            defaultActiveKey={['photos']}
            ghost
            size="small"
            items={[
              {
                key: 'photos',
                label: <Typography.Text strong>Фото ({d.photos.length})</Typography.Text>,
                children:
                  d.photos.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="Нет фото"
                      style={{ margin: '12px 0' }}
                    />
                  ) : (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      {before.length > 0 && (
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            1 Этап ({before.length})
                          </Typography.Text>
                          <PhotoViewedCounter photos={before} small />
                          <div style={{ marginTop: 4 }}>
                            <PhotoGallery
                              deliveryId={d.id}
                              photos={before}
                              operationKind="delivery"
                            />
                          </div>
                        </div>
                      )}
                      {after.length > 0 && (
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            2 Этап ({after.length})
                          </Typography.Text>
                          <PhotoViewedCounter photos={after} small />
                          <div style={{ marginTop: 4 }}>
                            <PhotoGallery
                              deliveryId={d.id}
                              photos={after}
                              operationKind="delivery"
                            />
                          </div>
                        </div>
                      )}
                    </Space>
                  ),
              },
            ]}
          />

          <div>
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
              Материалы ({items.length})
            </Typography.Title>
            {d.recipientsPerDocument &&
            ((d.sourceDocuments?.length ?? 0) > 0 || (d.edoDocuments?.length ?? 0) > 0) ? (
              <Collapse
                size="small"
                items={[
                  ...(d.sourceDocuments ?? []).map((doc) => ({
                    key: doc.id,
                    label: `Материалы · ${sourceKindLabel(doc.kind)} № ${doc.docNumber ?? 'без номера'}`,
                    extra: doc.linked ? (
                      <DocumentRecipientChips
                        delivery={d}
                        docId={doc.id}
                        canEditRecipient={false}
                        canPickContractor={false}
                        canEditPurpose={false}
                        mols={[]}
                        molsLoading={false}
                        onRecipient={() => {}}
                        onPurpose={() => {}}
                      />
                    ) : null,
                    children: renderItemsTable(
                      items.filter((item) => item.sourceDocumentId === doc.id),
                    ),
                  })),
                  // УПД из ЭДО без скана — документы того же режима (0152). Данные
                  // — из строки списка (то же право просмотра, что у окна), а не
                  // из чтения ЭДО: оно требует права правки. Строк факта у такой
                  // УПД нет (они в блоке «без документа»), поэтому строка-заголовок.
                  ...(d.edoDocuments ?? []).map((edo) => ({
                    key: `edo:${edo.matchId}`,
                    label: `Материалы · УПД № ${edo.docNumber ?? 'без номера'} из ЭДО · ${edoOperatorLabel(edo.operator)}`,
                    collapsible: 'disabled' as const,
                    showArrow: false,
                    extra: (
                      <DocumentRecipientChips
                        delivery={d}
                        edoMatchId={edo.matchId}
                        canEditRecipient={false}
                        canPickContractor={false}
                        canEditPurpose={false}
                        mols={[]}
                        molsLoading={false}
                        onRecipient={() => {}}
                        onPurpose={() => {}}
                      />
                    ),
                  })),
                  ...(items.some(
                    (item) =>
                      !item.sourceDocumentId ||
                      !(d.sourceDocuments ?? []).some((doc) => doc.id === item.sourceDocumentId),
                  )
                    ? [
                        {
                          key: 'no-document',
                          label: 'Материалы · без документа',
                          children: renderItemsTable(
                            items.filter(
                              (item) =>
                                !item.sourceDocumentId ||
                                !(d.sourceDocuments ?? []).some(
                                  (doc) => doc.id === item.sourceDocumentId,
                                ),
                            ),
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              renderItemsTable(items)
            )}
          </div>
        </Space>
      ) : null}
    </Modal>
  );
}
