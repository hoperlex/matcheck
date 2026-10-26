import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Alert, Button, Collapse, Space, Spin, Tag, Typography } from 'antd';
import { useAutoOpenKeys } from '../../shared/hooks/useAutoOpenKeys';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { edoOperatorLabel } from '../shared/edoOperator';
import { EdoCompareDrawer, type ComparePhoto } from './EdoCompareDrawer';
import type { LinkedEdoDocument } from './LinkedEdoChips';
import { edoTotals, factTotals, formatPartialSum, type FactRow } from './edoSectionTotals';
import type { EdoItem, EdoItemsEntry, EdoItemsResponse } from './useDeliveryEdoItems';

/**
 * Блок материалов с привязанной УПД из ЭДО/СБИС.
 *
 * Сверху — строки УПД из ЭДО, только чтение: это юридический документ, и он
 * будет основой для «Реализации». Ниже, свёрнутым подблоком, — факт приёмки
 * (распознанное со скана и правленное инспектором): его по-прежнему правят,
 * по нему считают отчёты, его переписывает планшет. Строки ЭДО в факт не
 * переносятся и с ним не сопоставляются.
 */

const QTY = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });

/** ПрТовРаб, кроме «имущества»: у материала пометки нет. */
const KIND_LABELS: Record<number, string> = {
  2: 'работа',
  3: 'услуга',
  4: 'имущественные права',
  5: 'иное',
};

function qtyText(qty: number): string {
  // 0 — в файле нет КолТов: «0» читалось бы как «ничего не поставили».
  return qty === 0 ? '—' : QTY.format(qty);
}

function rateText(rate: number | null): string {
  return rate === null ? '—' : `${QTY.format(rate)}%`;
}

function ItemName({ item }: { item: EdoItem }) {
  const kind = item.itemKind !== null ? KIND_LABELS[item.itemKind] : undefined;
  return (
    <span>
      {item.nameRaw}
      {kind && (
        <Tag style={{ marginInlineStart: 6 }} color="default">
          {kind}
        </Tag>
      )}
    </span>
  );
}

// Числа — фиксированной ширины: остальное место уходит наименованию, иначе
// длинные названия УПД ломаются в столбик по два слова.
const columns = [
  {
    title: '№',
    key: 'no',
    width: 48,
    render: (_: unknown, item: EdoItem) => item.lineNo ?? item.position + 1,
  },
  {
    title: 'Наименование',
    key: 'name',
    render: (_: unknown, item: EdoItem) => <ItemName item={item} />,
  },
  {
    title: 'Кол-во',
    key: 'qty',
    width: 90,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => qtyText(item.qty),
  },
  { title: 'Ед.', key: 'unit', width: 64, render: (_: unknown, item: EdoItem) => item.unit ?? '—' },
  {
    title: 'Цена без НДС',
    key: 'price',
    width: 120,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => formatMoneyRu(item.price),
  },
  {
    title: 'НДС %',
    key: 'rate',
    width: 72,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => rateText(item.vatRate),
  },
  {
    title: 'Сумма НДС',
    key: 'vat',
    width: 120,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => formatMoneyRu(item.vatSum),
  },
  {
    title: 'Сумма без НДС',
    key: 'exVat',
    width: 130,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => formatMoneyRu(item.sumExVat),
  },
  {
    title: 'Сумма с НДС',
    key: 'sum',
    width: 130,
    align: 'right' as const,
    render: (_: unknown, item: EdoItem) => formatMoneyRu(item.sum),
  },
];

function itemCard(item: EdoItem) {
  return (
    <div style={{ width: '100%' }}>
      <Typography.Text strong>№{item.lineNo ?? item.position + 1}</Typography.Text>{' '}
      <ItemName item={item} />
      <div style={{ marginTop: 4 }}>
        <Typography.Text type="secondary">
          {qtyText(item.qty)} {item.unit ?? ''} × {formatMoneyRu(item.price)} · НДС{' '}
          {rateText(item.vatRate)} {formatMoneyRu(item.vatSum)}
        </Typography.Text>
      </div>
      <div>
        без НДС {formatMoneyRu(item.sumExVat)} · с НДС {formatMoneyRu(item.sum)}
      </div>
    </div>
  );
}

/** «По УПД из ЭДО · СБИС № 41296 от 23.10.2026 · исправление № 1». */
function documentTitle(entry: EdoItemsEntry): string {
  const label = entry.data?.label;
  const operator = label?.operator ?? entry.match.operator;
  const number = label?.docNumber ?? entry.match.docNumber;
  const date = label?.docDate ?? entry.match.docDate;
  const correction = label?.correctionNumber;
  return [
    `По УПД из ЭДО · ${edoOperatorLabel(operator)} № ${number ?? 'без номера'}`,
    date ? ` от ${formatDateRu(date)}` : '',
    correction ? ` · исправление № ${correction}` : '',
  ].join('');
}

export type EdoFileActions = {
  /** Сырой XML (оригинал импорта) — `GET …/edo-matches/:matchId/file`. */
  onOpenXml: (match: LinkedEdoDocument) => void;
  /** PDF из XML рядом с фото приёмки; только у УПД из реестра. */
  onOpenPdf: (match: LinkedEdoDocument, event: MouseEvent<HTMLElement>) => void;
};

/** Одна УПД из ЭДО: заголовок и строки — или то, почему строк нет. */
function EdoDocumentLines({ entry, actions }: { entry: EdoItemsEntry; actions: EdoFileActions }) {
  const { match, data } = entry;
  const xmlButton = (
    <Button size="small" onClick={() => actions.onOpenXml(match)}>
      Открыть XML
    </Button>
  );
  let body: ReactNode;
  if (entry.status === 'loading') {
    body = (
      <Space>
        <Spin size="small" />
        <Typography.Text type="secondary">Загружаю строки УПД…</Typography.Text>
      </Space>
    );
  } else if (entry.status === 'error' || data?.state === 'storage_failed') {
    body = (
      <Alert
        type="warning"
        showIcon
        message="Строки УПД не загрузились"
        description="Файл УПД не получен — повторите. Факт приёмки ниже доступен как обычно."
        action={
          <Button size="small" onClick={entry.refetch}>
            Повторить
          </Button>
        }
      />
    );
  } else if (data?.state === 'parse_failed') {
    body = (
      <Alert
        type="warning"
        showIcon
        message="Файл УПД не разобрался"
        description="Строки не показать — источник правды остаётся в XML документа."
        action={xmlButton}
      />
    );
  } else if (data?.state === 'too_large') {
    body = (
      <Alert
        type="info"
        showIcon
        message="УПД слишком большая для карточки"
        description={data.reasons.length ? data.reasons.join('; ') : 'Откройте XML документа.'}
        action={xmlButton}
      />
    );
  } else if (data?.state === 'incomplete') {
    body = (
      <Alert
        type="warning"
        showIcon
        message="В файле УПД не прочитаны позиции"
        description={data.reasons.join('; ')}
        action={
          <Space direction="vertical">
            {data.source === 'export' && (
              <Button size="small" onClick={(event) => actions.onOpenPdf(match, event)}>
                Открыть файл
              </Button>
            )}
            {xmlButton}
          </Space>
        }
      />
    );
  } else if (data) {
    body = (
      <ResponsiveTable<EdoItem>
        items={data.items}
        columns={columns}
        rowKey={(item) => String(item.position)}
        cardRender={itemCard}
        // Как у блоков материалов: собственный скролл у каждой таблицы
        // превратил бы карточку в набор окон.
        scrollY={false}
        pagination={{ pageSize: 100, showSizeChanger: false, hideOnSinglePage: true }}
      />
    );
  }
  return (
    <div>
      <Typography.Text strong>{documentTitle(entry)}</Typography.Text>
      <div style={{ marginTop: 6 }}>{body}</div>
    </div>
  );
}

/** Готова ли УПД: строки есть и показаны. */
function isReady(entry: EdoItemsEntry): entry is EdoItemsEntry & { data: EdoItemsResponse } {
  return entry.status === 'done' && entry.data?.state === 'ready';
}

/**
 * Счётчик для заголовка блока: строки готовых УПД; «…» — пока грузятся;
 * пусто — какая-то УПД не готова (сбой виден внутри блока).
 */
export function edoCountLabel(entries: readonly EdoItemsEntry[]): string {
  if (entries.some((entry) => entry.status === 'loading')) return ' (…)';
  if (!entries.every(isReady)) return '';
  return ` (${entries.reduce((n, entry) => n + (entry.data?.items.length ?? 0), 0)})`;
}

/** Все УПД блока готовы — тогда и только тогда факт сворачивается сам. */
export function allEdoReady(entries: readonly EdoItemsEntry[]): boolean {
  return entries.length > 0 && entries.every(isReady);
}

/**
 * Раскрыт ли подблок «Факт приёмки» в блоке с ЭДО — состояние по id документа.
 *
 * Выбор человека важнее всего. Выбора нет — подблок раскрыт, пока строки ЭДО
 * блока не готовы (при загрузке и любом сбое факт под рукой), и свёрнут, когда
 * готовы. Новая строка («+ Материал») ложится в факт и раскрывает его — иначе
 * её не было бы видно; это считается выбором человека.
 *
 * Живёт в карточке, а не в теле блока: тело перемонтируется, а опрос
 * карточки каждые 5 с выбор сбрасывать не должен.
 */
export function useFactPanels() {
  const [choice, setChoice] = useState<Record<string, boolean>>({});
  return {
    isOpen: (documentId: string, entries: readonly EdoItemsEntry[]) =>
      choice[documentId] ?? !allEdoReady(entries),
    setOpen: (documentId: string, open: boolean) =>
      setChoice((prev) => ({ ...prev, [documentId]: open })),
    rowAdded: (documentId: string) => setChoice((prev) => ({ ...prev, [documentId]: true })),
  };
}

/** Панель «PDF рядом с фото» для УПД из реестра — та же, что у чипа. */
function useEdoPdf(
  deliveryId: string,
  photos: readonly ComparePhoto[],
  onOpenXml: (m: LinkedEdoDocument) => void,
) {
  const [compare, setCompare] = useState<LinkedEdoDocument | null>(null);
  const [open, setOpen] = useState(false);
  // Куда вернуть фокус после панели: в обёртку карточки-модалки, иначе
  // следующий ESC её не закроет (см. LinkedEdoChips).
  const focusReturn = useRef<HTMLElement | null>(null);
  const openPdf = (match: LinkedEdoDocument, event: MouseEvent<HTMLElement>) => {
    focusReturn.current = event.currentTarget.closest<HTMLElement>('.ant-modal-wrap');
    setCompare(match);
    setOpen(true);
  };
  const drawer = (
    <EdoCompareDrawer
      open={open}
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
      onClose={() => setOpen(false)}
      afterClose={() => {
        focusReturn.current?.focus({ preventScroll: true });
        setCompare(null);
      }}
      onOpenXml={() => {
        if (compare) onOpenXml(compare);
      }}
    />
  );
  return { openPdf, drawer };
}

const FACT_KEY = 'fact';

export function DeliveryEdoSectionBody({
  deliveryId,
  entries,
  factTable,
  factRows,
  factCaption,
  factOpen,
  onFactOpenChange,
  photos,
  onOpenXml,
}: {
  deliveryId: string;
  /** УПД из ЭДО, привязанные к этому блоку. */
  entries: readonly EdoItemsEntry[];
  /** Таблица факта — та же, что была телом блока без ЭДО. */
  factTable: ReactNode;
  factRows: readonly FactRow[];
  /** Подпись подблока факта: «Факт приёмки — распознано со скана (M)» и пометки. */
  factCaption: ReactNode;
  factOpen: boolean;
  onFactOpenChange: (open: boolean) => void;
  photos: readonly ComparePhoto[];
  onOpenXml: (match: LinkedEdoDocument) => void;
}) {
  const { openPdf, drawer } = useEdoPdf(deliveryId, photos, onOpenXml);
  const actions: EdoFileActions = { onOpenXml, onOpenPdf: openPdf };
  const ready = entries.filter(isReady).map((entry) => entry.data);
  const edo = edoTotals(ready);
  const fact = factTotals(factRows);
  const edoSummary =
    ready.length === entries.length
      ? `ЭДО: строк ${edo.count} · без НДС ${formatPartialSum(edo.exVat, 'итога без НДС', 'documents')} · НДС ${formatPartialSum(edo.vat, 'НДС', 'documents')}`
      : 'ЭДО: …';
  const factSummary = `Факт: строк ${fact.count} · без НДС ${formatPartialSum(fact.exVat, 'цены', 'rows')} · НДС ${formatPartialSum(fact.vat, 'НДС', 'rows')}`;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {entries.map((entry) => (
        <EdoDocumentLines key={entry.match.id} entry={entry} actions={actions} />
      ))}
      <div>
        <div>
          <Typography.Text type="secondary">{edoSummary}</Typography.Text>
        </div>
        <div>
          <Typography.Text type="secondary">{factSummary}</Typography.Text>
        </div>
      </div>
      <Collapse
        size="small"
        activeKey={factOpen ? [FACT_KEY] : []}
        onChange={(keys) =>
          onFactOpenChange((Array.isArray(keys) ? keys : [keys]).includes(FACT_KEY))
        }
        items={[{ key: FACT_KEY, label: factCaption, children: factTable }]}
      />
      {drawer}
    </Space>
  );
}

/**
 * УПД из ЭДО без блока бумажного документа: привязаны к приёмке целиком или их
 * бумажный документ отвязан. Отдельный блок на каждую, раскрыт сразу.
 */
export function DeliveryEdoOnlyBlocks({
  deliveryId,
  entries,
  photos,
  onOpenXml,
}: {
  deliveryId: string;
  entries: readonly EdoItemsEntry[];
  photos: readonly ComparePhoto[];
  onOpenXml: (match: LinkedEdoDocument) => void;
}) {
  const [openKeys, setOpenKeys] = useAutoOpenKeys(entries.map((entry) => entry.match.id));
  const { openPdf, drawer } = useEdoPdf(deliveryId, photos, onOpenXml);
  if (entries.length === 0) return null;
  const actions: EdoFileActions = { onOpenXml, onOpenPdf: openPdf };
  return (
    <>
      <Collapse
        size="small"
        activeKey={openKeys}
        onChange={(keys) => setOpenKeys(Array.isArray(keys) ? keys : [keys])}
        items={entries.map((entry) => {
          const operator = entry.data?.label.operator ?? entry.match.operator;
          const number = entry.data?.label.docNumber ?? entry.match.docNumber;
          return {
            key: entry.match.id,
            label: `Материалы · УПД № ${number ?? 'без номера'} из ЭДО · ${edoOperatorLabel(operator)}${edoCountLabel([entry])}`,
            children: <EdoDocumentLines entry={entry} actions={actions} />,
          };
        })}
      />
      {drawer}
    </>
  );
}
