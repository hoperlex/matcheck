import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Splitter,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResponsiblePerson,
  SourceDirection,
  SourceDocumentDetail,
  SourceDocumentFileResponse,
  UpdCheck,
} from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, ApiError } from '../../services/api';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import {
  formatDateRu,
  formatMoneyRu,
  inputNumberFormatterRu,
  inputNumberParserRu,
} from '../../shared/utils/formatRu';
import { LlmCallsDrawer } from './LlmCallsDrawer';
import { ContractorSelect } from './ContractorSelect';
import { SiteSelect } from './SiteSelect';

type Item = SourceDocumentDetail['items'][number];

type EditItem = {
  nameRaw: string;
  qty: string;
  unit: string;
  price: string | null;
  sum: string | null;
};

type EditForm = {
  docNumber: string | null;
  docDate: Dayjs | null;
  expectedDate: Dayjs | null;
  recipientKind: 'counterparty' | 'mol';
  contractorId: string | null;
  recipientMolId: string | null;
  siteId: string | null;
  totalSum: string | null;
  items: EditItem[];
};

function directionLabel(d: SourceDirection): string {
  return d === 'inbound' ? 'Приёмка' : 'Отгрузка';
}

function describeCheck(c: UpdCheck): string {
  const where = c.scope === 'document' ? 'по документу' : `строка ${c.scope.row}`;
  const name =
    {
      sum_total: 'сумма позиций vs итог документа',
      vat_total: 'НДС позиций vs НДС документа',
      items_count: 'количество позиций vs «Всего наименований»',
      row_qty_price: 'qty × price ≠ sum',
      row_vat_rate: 'sum × ставка ≠ НДС',
    }[c.name] || c.name;
  const exp = c.expected != null ? c.expected.toFixed(2) : '—';
  const act = c.actual != null ? c.actual.toFixed(2) : '—';
  return `${name} (${where}): ожидается ${exp}, по факту ${act}`;
}

function itemToEdit(i: Item): EditItem {
  return {
    nameRaw: i.nameRaw,
    qty: i.qty,
    unit: i.unit,
    price: i.price,
    sum: i.sum,
  };
}

// Сплит-режим модалки: 'stacked' — позиции сверху, оригинал снизу (горизонтальный
// разделитель); 'sideBySide' — позиции слева, оригинал справа (вертикальный). В
// antd Splitter ориентация инвертирована: layout='vertical' = панели стек-ом,
// layout='horizontal' = панели рядом.
type SplitMode = 'stacked' | 'sideBySide';
const LAYOUT_LS_KEY = 'matcheck.docModal.layout';

function readLayout(): SplitMode {
  if (typeof window === 'undefined') return 'stacked';
  const v = window.localStorage.getItem(LAYOUT_LS_KEY);
  return v === 'sideBySide' ? 'sideBySide' : 'stacked';
}

// Порог 1280px подобран под минимально читаемый PDF в правой/нижней панели.
// Ниже — split-layout схлопывается до старых вкладок (Позиции/Шапка/Оригинал).
function useIsWideViewport(): boolean {
  const [wide, setWide] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 1280,
  );
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1280);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}

function initialForm(sd: SourceDocumentDetail): EditForm {
  return {
    docNumber: sd.docNumber,
    docDate: sd.docDate ? dayjs(sd.docDate) : null,
    expectedDate: sd.expectedDate ? dayjs(sd.expectedDate) : null,
    // Если у УПД сохранён МОЛ — открываем переключатель в его сторону,
    // иначе по умолчанию — подрядчик (исторический режим).
    recipientKind: sd.recipientMolId ? 'mol' : 'counterparty',
    contractorId: sd.contractorId,
    recipientMolId: sd.recipientMolId,
    siteId: sd.siteId,
    totalSum: sd.totalSum,
    items: sd.items.map(itemToEdit),
  };
}

export function SourceDocumentDetailModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role ?? null);
  const [edit, setEdit] = useState<EditForm | null>(null);
  const [llmDrawerOpen, setLlmDrawerOpen] = useState(false);
  const isWide = useIsWideViewport();
  const [layout, setLayoutState] = useState<SplitMode>(readLayout);
  const setLayout = (next: SplitMode) => {
    setLayoutState(next);
    try {
      window.localStorage.setItem(LAYOUT_LS_KEY, next);
    } catch {
      // localStorage может быть недоступен (privacy mode) — молча игнорируем.
    }
  };

  const detail = useQuery({
    queryKey: ['source-document', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
    enabled: open && !!id,
  });

  const responsiblePersonsQuery = useQuery({
    queryKey: ['responsible-persons', 'active'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(
        '/responsible-persons?activeOnly=true&limit=500',
      ),
  });
  const responsiblePersons = responsiblePersonsQuery.data?.items ?? [];

  const file = useQuery({
    queryKey: ['source-document-file', id],
    queryFn: () => api.get<SourceDocumentFileResponse>(`/source-documents/${id}/file`),
    enabled: open && !!id,
    retry: false,
  });

  const sd = detail.data;
  const items = sd?.items ?? [];
  const isProcessing = sd?.status === 'queued' || sd?.status === 'processing';
  const failedChecks = useMemo<UpdCheck[]>(() => {
    if (!sd?.validation?.checks) return [];
    return sd.validation.checks.filter((c) => !c.ok && !c.skipReason);
  }, [sd]);

  // При смене документа сбрасываем форму. При первом открытии — инициализируем.
  useEffect(() => {
    if (sd) {
      setEdit(initialForm(sd));
    } else {
      setEdit(null);
    }
  }, [sd]);

  const switchDirection = useMutation({
    mutationFn: (next: SourceDirection) =>
      api.patch<SourceDocumentDetail>(`/source-documents/${id}/direction`, { direction: next }),
    onSuccess: () => {
      message.success('Направление обновлено');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(`Не удалось: ${err.message}`),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<SourceDocumentDetail>(`/source-documents/${id}`, body),
    onSuccess: () => {
      message.success('Документ сохранён');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const ack = useMutation({
    mutationFn: () =>
      api.post<SourceDocumentDetail>(`/source-documents/${id}/acknowledge-mismatch`, {}),
    onSuccess: () => {
      message.success('Расхождение принято');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  function onSave() {
    if (!edit) return;
    // Получатель — взаимоисключающий выбор: либо contractorId, либо
    // recipientMolId. Очищаем «противоположное» поле явно, чтобы
    // PATCH сбрасывал ранее сохранённое значение.
    const body: Record<string, unknown> = {
      docNumber: edit.docNumber,
      docDate: edit.docDate ? edit.docDate.format('YYYY-MM-DD') : null,
      expectedDate: edit.expectedDate ? edit.expectedDate.format('YYYY-MM-DD') : null,
      contractorId: edit.recipientKind === 'counterparty' ? edit.contractorId : null,
      recipientMolId: edit.recipientKind === 'mol' ? edit.recipientMolId : null,
      siteId: edit.siteId,
      totalSum: edit.totalSum,
      items: edit.items.map((it) => ({
        nameRaw: it.nameRaw,
        qty: it.qty,
        unit: it.unit,
        price: it.price,
        sum: it.sum,
      })),
    };
    patch.mutate(body);
  }

  const nextDirection: SourceDirection | null = sd
    ? sd.direction === 'inbound'
      ? 'outbound'
      : 'inbound'
    : null;

  const isMismatchPending =
    sd?.status === 'needs_resolution' && sd.parseErrorCode === 'validation_mismatch';
  const isDuplicate =
    sd?.status === 'needs_resolution' && sd.parseErrorCode === 'duplicate_upd';

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        maskClosable={false}
        keyboard={false}
        title={
          sd ? (
            <Space size={4} wrap style={{ fontSize: 12 }}>
              <Tag
                style={{ marginInlineEnd: 0 }}
                color={sd.direction === 'inbound' ? 'green' : 'purple'}
              >
                {directionLabel(sd.direction)}
              </Tag>
              <Tag
                style={{ marginInlineEnd: 0 }}
                color={
                  sd.kind === 'upd'
                    ? 'blue'
                    : sd.kind === 'transport_waybill' || sd.kind === 'os2_transfer'
                      ? 'purple'
                      : 'gold'
                }
              >
                {sd.kind === 'upd'
                  ? 'УПД'
                  : sd.kind === 'transport_waybill' || sd.kind === 'os2_transfer'
                    ? 'Накладная'
                    : 'Заявка'}
              </Tag>
              {sd.siteName ? (
                <Tag style={{ marginInlineEnd: 0 }}>Объект: {sd.siteName}</Tag>
              ) : null}
              {sd.contractorName ? (
                <Tag style={{ marginInlineEnd: 0 }}>Подрядчик: {sd.contractorName}</Tag>
              ) : null}
              {sd.recipientMolName ? (
                <Tag style={{ marginInlineEnd: 0 }}>МОЛ: {sd.recipientMolName}</Tag>
              ) : null}
              {sd.supplierName ? (
                <Tag style={{ marginInlineEnd: 0 }}>Поставщик: {sd.supplierName}</Tag>
              ) : null}
              {sd.llmConfidence != null && (
                <Tag style={{ marginInlineEnd: 0 }}>
                  Уверенность: {Math.round(Number(sd.llmConfidence) * 100)}%
                </Tag>
              )}
            </Space>
          ) : (
            'Документ'
          )
        }
        width="97vw"
        style={{ top: 4 }}
        styles={{
          header: { padding: '8px 16px', marginBottom: 0 },
          body: { padding: '6px 12px' },
          footer: { padding: '6px 12px' },
        }}
        footer={
          sd ? (
            <Space wrap>
              {role === 'admin' && (
                <Button onClick={() => setLlmDrawerOpen(true)}>Логи распознавания</Button>
              )}
              {nextDirection && (
                <Button
                  onClick={() => switchDirection.mutate(nextDirection)}
                  loading={switchDirection.isPending}
                >
                  Перевести в «{directionLabel(nextDirection)}»
                </Button>
              )}
              {isMismatchPending && (
                <Button onClick={() => ack.mutate()} loading={ack.isPending}>
                  Принять как есть
                </Button>
              )}
              {!isProcessing && !isDuplicate && (
                <Button type="primary" onClick={onSave} loading={patch.isPending}>
                  Сохранить
                </Button>
              )}
            </Space>
          ) : null
        }
        destroyOnClose
      >
        {detail.isLoading && (
          <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
            <Spin size="large" />
          </Space>
        )}
        {detail.error && (
          <Alert
            type="error"
            message="Не удалось загрузить документ"
            description={(detail.error as Error).message}
            showIcon
          />
        )}
        {sd && (
          <>
            {isProcessing && (
              <Alert
                style={{ marginBottom: 12 }}
                type="info"
                showIcon
                message="Документ ещё распознаётся"
                description="Окно обновится автоматически, когда распознавание завершится."
              />
            )}
            {isDuplicate && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="Это дубликат уже существующего УПД"
                description="Откройте список «Документы» и нажмите «Разрешить» в строке этого документа."
              />
            )}
            {sd.status === 'parse_failed' && (
              <Alert
                style={{ marginBottom: 12 }}
                type="error"
                showIcon
                message={`Ошибка распознавания: ${sd.parseErrorCode ?? 'unknown'}`}
                description={
                  (sd.parseErrorDetails as { message?: string } | null)?.message ?? null
                }
              />
            )}
            {failedChecks.length > 0 && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="Расхождения в сумах"
                description={
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {failedChecks.map((c, i) => (
                      <li key={i}>{describeCheck(c)}</li>
                    ))}
                  </ul>
                }
              />
            )}

            {renderBody({
              isWide,
              layout,
              setLayout,
              itemsNode: edit && !isProcessing && !isDuplicate ? (
                <EditableTable
                  edit={edit}
                  setEdit={setEdit}
                  failedRows={new Set(
                    failedChecks
                      .map((c) => (typeof c.scope === 'object' ? c.scope.row : null))
                      .filter((x): x is number => x != null),
                  )}
                />
              ) : (
                <ReadOnlyTable items={items} showInvNumber={sd.kind === 'os2_transfer'} />
              ),
              headerNode: edit && !isProcessing && !isDuplicate ? (
                <Form layout="vertical" style={{ maxWidth: 500 }}>
                  <Form.Item label="№ документа">
                    <Input
                      value={edit.docNumber ?? ''}
                      onChange={(e) =>
                        setEdit({ ...edit, docNumber: e.target.value || null })
                      }
                    />
                  </Form.Item>
                  <Form.Item label="Дата">
                    <DatePicker
                      value={edit.docDate}
                      onChange={(d) => setEdit({ ...edit, docDate: d })}
                      format="DD.MM.YYYY"
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item label="Сумма">
                    <InputNumber
                      value={edit.totalSum != null ? Number(edit.totalSum) : null}
                      onChange={(v) =>
                        setEdit({ ...edit, totalSum: v != null ? String(v) : null })
                      }
                      decimalSeparator=","
                      formatter={inputNumberFormatterRu}
                      parser={inputNumberParserRu}
                      addonAfter="₽"
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item label="Дата поставки">
                    <DatePicker
                      value={edit.expectedDate}
                      onChange={(d) => setEdit({ ...edit, expectedDate: d })}
                      format="DD.MM.YYYY"
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item label="Получатель">
                    <Segmented
                      block
                      style={{ marginBottom: 8 }}
                      value={edit.recipientKind}
                      onChange={(v) => {
                        const next = v as 'counterparty' | 'mol';
                        setEdit({
                          ...edit,
                          recipientKind: next,
                          contractorId: next === 'counterparty' ? edit.contractorId : null,
                          recipientMolId: next === 'mol' ? edit.recipientMolId : null,
                        });
                      }}
                      options={[
                        { label: 'Подрядчик', value: 'counterparty' },
                        { label: 'МОЛ', value: 'mol' },
                      ]}
                    />
                    {edit.recipientKind === 'counterparty' ? (
                      <ContractorSelect
                        value={edit.contractorId}
                        onChange={(v) => setEdit({ ...edit, contractorId: v })}
                        placeholder="Выберите получателя"
                      />
                    ) : (
                      <Select<string>
                        style={{ width: '100%' }}
                        placeholder="Выберите получателя"
                        value={edit.recipientMolId ?? undefined}
                        onChange={(v) =>
                          setEdit({ ...edit, recipientMolId: v ?? null })
                        }
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={responsiblePersonsQuery.isLoading}
                        options={responsiblePersons.map((m) => ({
                          value: m.id,
                          label: m.fullName,
                        }))}
                        notFoundContent={
                          <Typography.Text type="secondary">
                            Заведите МОЛ в Справочниках
                          </Typography.Text>
                        }
                      />
                    )}
                  </Form.Item>
                  <Form.Item label="Объект">
                    <SiteSelect
                      value={edit.siteId}
                      onChange={(v) => setEdit({ ...edit, siteId: v })}
                    />
                  </Form.Item>
                </Form>
              ) : (
                <ReadOnlyHeader sd={sd} />
              ),
              originalNode:
                sd.attachments.length > 0 ? (
                  // Для УПД обычно один attachment, для ТН — пакет фото
                  // (лицевая + оборотная сторона + сопроводилки). Каждый
                  // файл — отдельный iframe: браузер сам справляется и с
                  // PDF, и с image/jpeg|png.
                  <OriginalAttachments
                    attachments={sd.attachments}
                    id={id!}
                    compact={isWide}
                  />
                ) : file.isLoading ? (
                  <Spin />
                ) : (
                  <Typography.Text type="secondary">
                    {file.error instanceof ApiError && file.error.status === 404
                      ? 'Оригинальный файл недоступен (документ загружен из XML).'
                      : 'Не удалось получить оригинал.'}
                  </Typography.Text>
                ),
              itemsCount: edit?.items.length ?? items.length,
              attachmentsCount: sd.attachments.length,
            })}
          </>
        )}
      </Modal>
      <LlmCallsDrawer
        sourceDocumentId={id}
        open={llmDrawerOpen}
        onClose={() => setLlmDrawerOpen(false)}
      />
    </>
  );
}

// Тело модалки: на широком экране — Collapse «Реквизиты» + Splitter «Позиции/Оригинал»
// с toggle ориентации; на узком — старые вкладки Позиции/Шапка/Оригинал (PDF в split
// на 700px нечитаем). Высота 78vh — рассчитана под чипы шапки модалки и футер с
// кнопками; внутри Splitter растягивается по flex.
function renderBody(args: {
  isWide: boolean;
  layout: SplitMode;
  setLayout: (next: SplitMode) => void;
  itemsNode: ReactNode;
  headerNode: ReactNode;
  originalNode: ReactNode;
  itemsCount: number;
  attachmentsCount: number;
}): ReactNode {
  const {
    isWide,
    layout,
    setLayout,
    itemsNode,
    headerNode,
    originalNode,
    itemsCount,
    attachmentsCount,
  } = args;

  if (!isWide) {
    return (
      <Tabs
        defaultActiveKey="items"
        items={[
          {
            key: 'items',
            label: `Позиции (${itemsCount})`,
            children: itemsNode,
          },
          {
            key: 'header',
            label: 'Шапка',
            children: headerNode,
          },
          {
            key: 'original',
            label:
              attachmentsCount > 1 ? `Оригинал (${attachmentsCount})` : 'Оригинал',
            children: originalNode,
          },
        ]}
      />
    );
  }

  // antd Splitter: layout='vertical' = панели стекируются (разделитель горизонтальный);
  // layout='horizontal' = панели бок о бок (разделитель вертикальный).
  const splitterLayout: 'vertical' | 'horizontal' =
    layout === 'stacked' ? 'vertical' : 'horizontal';

  // Размер панели «Позиции» по умолчанию: подбираем так, чтобы редактируемая
  // таблица (6 колонок: №/Наименование/Кол-во/Ед./Цена/Сумма + кнопка
  // удалить) помещалась без горизонтального скролла.
  //
  // sideBySide — границей решает ширина: editable-таблица с InputNumber+₽
  // требует минимум ~700px. Меньше — и колонки «Цена»/«Сумма» обрезаются,
  // символ ₽ не помещается. Поэтому отдаём пиксели, не %.
  //
  // stacked — границей решает высота. Тут оптимизируем: если позиций мало,
  // отдаём почти всю высоту оригиналу.
  const splitterMin: number | string = layout === 'sideBySide' ? 700 : '15%';
  function defaultItemsSize(): number | string {
    if (layout === 'sideBySide') {
      // Чуть больше для запаса; пользователь может сузить вручную.
      return itemsCount > 10 ? 800 : 720;
    }
    if (itemsCount <= 2) return '22%';
    if (itemsCount <= 5) return '32%';
    if (itemsCount <= 10) return '42%';
    return '50%';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '92vh', minHeight: 480 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 2,
        }}
      >
        <Collapse
          ghost
          size="small"
          style={{ flex: 1 }}
          items={[
            {
              key: 'header',
              label: 'Реквизиты документа',
              children: <div style={{ padding: '4px 0' }}>{headerNode}</div>,
            },
          ]}
        />
        <Tooltip title="Расположение панелей: позиции и оригинал">
          <Segmented
            size="small"
            value={layout}
            onChange={(v) => setLayout(v as SplitMode)}
            options={[
              {
                value: 'stacked',
                icon: <BorderHorizontalOutlined />,
                title: 'Сверху/снизу',
              },
              {
                value: 'sideBySide',
                icon: <BorderVerticleOutlined />,
                title: 'Слева/справа',
              },
            ]}
          />
        </Tooltip>
      </div>
      <Splitter
        key={splitterLayout}
        layout={splitterLayout}
        style={{ flex: 1, minHeight: 0, border: '1px solid #f0f0f0', borderRadius: 4 }}
      >
        <Splitter.Panel min={splitterMin} defaultSize={defaultItemsSize()}>
          <div
            style={{
              height: '100%',
              overflow: 'auto',
              padding: 8,
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Позиции ({itemsCount})
            </Typography.Text>
            <div style={{ marginTop: 4 }}>{itemsNode}</div>
          </div>
        </Splitter.Panel>
        <Splitter.Panel min="20%">
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              padding: 8,
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
              Оригинал{attachmentsCount > 1 ? ` (${attachmentsCount})` : ''}
            </Typography.Text>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{originalNode}</div>
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}

function OriginalAttachments({
  attachments,
  id,
  compact,
}: {
  attachments: ReadonlyArray<{ id: string; filename: string }>;
  id: string;
  // compact=true — внутри Splitter, iframe растягивается на всю панель;
  // compact=false — внутри Tabs (узкий экран), фиксированная высота как раньше.
  compact: boolean;
}) {
  if (compact) {
    // Если один файл — один iframe на всю панель. Если несколько — стек с
    // равными долями (плохо читается, но для редкого случая ТН ок).
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          height: '100%',
        }}
      >
        {attachments.map((a) => (
          <div
            key={a.id}
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            <Typography.Text
              type="secondary"
              style={{ fontSize: 11, display: 'block', marginBottom: 2 }}
            >
              {a.filename}
            </Typography.Text>
            <iframe
              // #toolbar=1&navpanes=0 — Chrome PDF Viewer прячет левую панель
              // с миниатюрами страниц, освобождая место для самого документа.
              // Параметр игнорируется браузером для image/*.
              src={`/api/v1/source-documents/${id}/file/raw?attachmentId=${a.id}#toolbar=1&navpanes=0`}
              title={a.filename}
              style={{
                flex: 1,
                width: '100%',
                minHeight: 200,
                border: '1px solid #f0f0f0',
              }}
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {attachments.map((a) => (
        <div key={a.id}>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
            {a.filename}
          </Typography.Text>
          <iframe
            src={`/api/v1/source-documents/${id}/file/raw?attachmentId=${a.id}`}
            title={a.filename}
            style={{
              width: '100%',
              height: attachments.length > 1 ? '60vh' : '75vh',
              border: '1px solid #f0f0f0',
            }}
          />
        </div>
      ))}
    </Space>
  );
}

function ReadOnlyTable({ items, showInvNumber }: { items: Item[]; showInvNumber?: boolean }) {
  // Колонка «Инв.№» отображается только для ОС-2 (kind='os2_transfer') —
  // у ТН и УПД она была бы пустой.
  const columns: NonNullable<ComponentProps<typeof Table<Item>>['columns']> = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    { title: 'Наименование', dataIndex: 'nameRaw' },
  ];
  if (showInvNumber) {
    columns.push({
      title: 'Инв.№',
      dataIndex: 'inventoryNumber',
      width: 110,
      render: (v: string | null) => v ?? '—',
    });
  }
  columns.push(
    {
      title: 'Кол-во',
      dataIndex: 'qty',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    { title: 'Ед.', dataIndex: 'unit', width: 60 },
    {
      title: 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      dataIndex: 'sum',
      width: 150,
      render: (v: string | null) => formatMoneyRu(v),
    },
  );
  return (
    <Table<Item>
      dataSource={items}
      rowKey="id"
      size="small"
      pagination={false}
      scroll={{ y: '60vh' }}
      columns={columns}
    />
  );
}

function ReadOnlyHeader({ sd }: { sd: SourceDocumentDetail }) {
  return (
    <Space direction="vertical">
      <Typography.Text>
        <b>№:</b> {sd.docNumber ?? '—'}
      </Typography.Text>
      <Typography.Text>
        <b>Дата:</b> {formatDateRu(sd.docDate)}
      </Typography.Text>
      <Typography.Text>
        <b>Сумма:</b> {formatMoneyRu(sd.totalSum)}
      </Typography.Text>
      <Typography.Text type="secondary">НДС: {formatMoneyRu(sd.vatSum)}</Typography.Text>
      <Typography.Text>
        <b>Дата поставки:</b> {formatDateRu(sd.expectedDate)}
      </Typography.Text>
      <Typography.Text>
        <b>Получатель:</b>{' '}
        {sd.recipientMolName
          ? `${sd.recipientMolName} (МОЛ)`
          : sd.contractorName
            ? `${sd.contractorName} (подрядчик)`
            : '—'}
      </Typography.Text>
      <Typography.Text>
        <b>Объект:</b> {sd.siteName ?? '—'}
      </Typography.Text>
    </Space>
  );
}

function EditableTable({
  edit,
  setEdit,
  failedRows,
}: {
  edit: EditForm;
  setEdit: (v: EditForm) => void;
  failedRows: ReadonlySet<number>;
}) {
  function updateItem(idx: number, patch: Partial<EditItem>) {
    const next = edit.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    setEdit({ ...edit, items: next });
  }
  function removeItem(idx: number) {
    setEdit({ ...edit, items: edit.items.filter((_, i) => i !== idx) });
  }
  function addItem() {
    setEdit({
      ...edit,
      items: [...edit.items, { nameRaw: '', qty: '1', unit: 'шт', price: null, sum: null }],
    });
  }

  return (
    <>
      <Table<EditItem & { idx: number }>
        dataSource={edit.items.map((it, idx) => ({ ...it, idx }))}
        rowKey="idx"
        size="small"
        pagination={false}
        scroll={{ y: '55vh' }}
        rowClassName={(r) => (failedRows.has(r.idx + 1) ? 'matcheck-row-mismatch' : '')}
        columns={[
          { title: '№', dataIndex: 'idx', width: 50, render: (idx: number) => idx + 1 },
          {
            title: 'Наименование',
            dataIndex: 'nameRaw',
            render: (v: string, _r, i) => (
              <Input value={v} onChange={(e) => updateItem(i, { nameRaw: e.target.value })} />
            ),
          },
          {
            title: 'Кол-во',
            dataIndex: 'qty',
            width: 110,
            render: (v: string, _r, i) => (
              <InputNumber
                value={Number(v)}
                onChange={(x) => updateItem(i, { qty: String(x ?? 0) })}
                decimalSeparator=","
                style={{ width: '100%' }}
              />
            ),
          },
          {
            title: 'Ед.',
            dataIndex: 'unit',
            width: 80,
            render: (v: string, _r, i) => (
              <Input value={v} onChange={(e) => updateItem(i, { unit: e.target.value })} />
            ),
          },
          {
            title: 'Цена',
            dataIndex: 'price',
            width: 160,
            render: (v: string | null, _r, i) => (
              <InputNumber
                value={v != null ? Number(v) : null}
                onChange={(x) => updateItem(i, { price: x != null ? String(x) : null })}
                decimalSeparator=","
                formatter={inputNumberFormatterRu}
                parser={inputNumberParserRu}
                addonAfter="₽"
                style={{ width: '100%' }}
              />
            ),
          },
          {
            title: 'Сумма',
            dataIndex: 'sum',
            width: 180,
            render: (v: string | null, _r, i) => (
              <InputNumber
                value={v != null ? Number(v) : null}
                onChange={(x) => updateItem(i, { sum: x != null ? String(x) : null })}
                decimalSeparator=","
                formatter={inputNumberFormatterRu}
                parser={inputNumberParserRu}
                addonAfter="₽"
                style={{ width: '100%' }}
              />
            ),
          },
          {
            title: '',
            key: 'rm',
            width: 50,
            render: (_v, _r, i) => (
              <Button
                danger
                type="text"
                icon={<DeleteOutlined />}
                onClick={() => removeItem(i)}
              />
            ),
          },
        ]}
      />
      <Button
        icon={<PlusOutlined />}
        onClick={addItem}
        style={{ marginTop: 8 }}
        type="dashed"
        block
      >
        Добавить позицию
      </Button>
      <style>{`.matcheck-row-mismatch td { background-color: #fff7e6 !important; }`}</style>
    </>
  );
}
