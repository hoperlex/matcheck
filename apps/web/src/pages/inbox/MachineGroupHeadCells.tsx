import type { MouseEvent, ReactNode } from 'react';
import { Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { UngroupOutlined } from '@ant-design/icons';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import type {
  HeadDateRange,
  HeadMoney,
  HeadValue,
  MachineHeadRow,
  MachineHeadSummary,
} from './machineGroupRows';

type Row = MachineHeadRow['group']['members'][number];

const stop = (event: MouseEvent) => event.stopPropagation();

/**
 * Диапазон дат покороче — колонка «Дата» узкая: «24.11.2026»,
 * «23–24.11.2026», «30.11–02.12.2026», «30.12.2025–02.01.2026».
 */
export function formatDateRangeRu(range: HeadDateRange): string {
  const to = formatDateRu(range.to);
  if (range.from === range.to) return to;
  const from = formatDateRu(range.from);
  if (range.from.slice(0, 7) === range.to.slice(0, 7)) return `${from.slice(0, 2)}–${to}`;
  if (range.from.slice(0, 4) === range.to.slice(0, 4)) return `${from.slice(0, 5)}–${to}`;
  return `${from}–${to}`;
}

/** Дата или диапазон — одной строкой: перенос посреди «23–24.11» не читается. */
function dateCell(range: HeadDateRange | null): ReactNode {
  return range ? <span style={{ whiteSpace: 'nowrap' }}>{formatDateRangeRu(range)}</span> : '—';
}

const mixed = <Typography.Text type="secondary">разные</Typography.Text>;

/** Общее значение рисуется так же, как у документа под строкой поставки. */
function valueCell(value: HeadValue, renderAs: (row: Row) => ReactNode): ReactNode {
  if (value.kind === 'same') return renderAs(value.row);
  if (value.kind === 'mixed') return mixed;
  return '—';
}

function moneyCell(money: HeadMoney | null): ReactNode {
  if (!money) return '—';
  const text = formatMoneyRu(money.amount);
  if (money.counted === money.of) return text;
  // Итог неполный: сумма распознана не у всех УПД поставки.
  return (
    <Tooltip title={`Сумма распознана у ${money.counted} из ${money.of} УПД`}>
      <Typography.Text type="secondary">{text}*</Typography.Text>
    </Tooltip>
  );
}

export type MachineHeadActions = {
  canUnmerge: boolean;
  onUnmerge: () => void;
  unmerging: boolean;
};

/** «Разъединить» у объединённой вручную машины. Клик не сворачивает строку. */
export function UnmergeButton({ onUnmerge, unmerging }: Omit<MachineHeadActions, 'canUnmerge'>) {
  return (
    <span onClick={stop}>
      <Popconfirm
        title="Разъединить машину?"
        description="Все отправки вернутся в исходные машины, на планшете снова будут отдельные карточки"
        okText="Разъединить"
        cancelText="Отмена"
        onConfirm={onUnmerge}
      >
        <Button size="small" icon={<UngroupOutlined />} loading={unmerging}>
          Разъединить
        </Button>
      </Popconfirm>
    </span>
  );
}

/**
 * Колонка «Статус» строки поставки — столбиком, каждая часть своей строкой:
 * в 260px тег приёмки и «объединена из N отправок» с «Разъединить» в одну
 * строку не влезают, а общий стиль таблицы обрезал бы хвост — вместе с кнопкой.
 */
function StatusCell({
  summary,
  actions,
}: {
  summary: MachineHeadSummary;
  actions: MachineHeadActions;
}) {
  const unmerge = summary.merged && actions.canUnmerge;
  if (!summary.accepted && !summary.origin) return null;
  return (
    <Space direction="vertical" size={2}>
      {summary.accepted && (
        <Tooltip
          title={
            summary.accepted.full === summary.accepted.label ? undefined : summary.accepted.full
          }
        >
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            {summary.accepted.label}
          </Tag>
        </Tooltip>
      )}
      {summary.origin && (
        <Space size={8} wrap>
          <Typography.Text type="secondary">{summary.origin}</Typography.Text>
          {unmerge && <UnmergeButton onUnmerge={actions.onUnmerge} unmerging={actions.unmerging} />}
        </Space>
      )}
    </Space>
  );
}

/**
 * Ячейка строки поставки в колонке `key` таблицы «Документы».
 *
 * Значения стоят в своих колонках, как у документов под ней: «Тип» — сколько
 * документов, «Статус» — принята ли, «№» — номера, даты, объект, стороны и
 * итог по УПД. Обобщения (даты, объект, стороны, суммы) — только у полной
 * машины: под фильтром `aggregates` пуст, и ячейки пустые.
 *
 * `renderAs` рисует ячейку колонки так же, как у документа, — общие объект и
 * стороны выглядят как в строках под шапкой (имя + ИНН второй строкой).
 */
export function machineHeadCell(
  summary: MachineHeadSummary,
  key: string,
  renderAs: (row: Row) => ReactNode,
  actions: MachineHeadActions,
): ReactNode {
  const agg = summary.aggregates;
  switch (key) {
    case 'kind':
      // «найдено 2 из 3» — про количество, поэтому здесь, под «3 документа».
      return (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{summary.title}</Typography.Text>
          {summary.found && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {summary.found}
            </Typography.Text>
          )}
        </Space>
      );
    case 'status':
      return <StatusCell summary={summary} actions={actions} />;
    case 'docNumber':
      return summary.numbers ? (
        <Typography.Text ellipsis={{ tooltip: summary.numbersFull }} style={{ maxWidth: '100%' }}>
          {summary.numbers}
        </Typography.Text>
      ) : null;
    case 'docDate':
      return agg ? dateCell(agg.docDate) : null;
    case 'expectedDate':
      return agg ? dateCell(agg.expectedDate) : null;
    case 'siteName':
      return agg ? valueCell(agg.site, renderAs) : null;
    case 'buyer':
      return agg ? valueCell(agg.buyer, renderAs) : null;
    case 'consignee':
      return agg ? valueCell(agg.consignee, renderAs) : null;
    case 'supplier':
      return agg ? valueCell(agg.supplier, renderAs) : null;
    case 'vatSum':
      return agg ? moneyCell(agg.vatSum) : null;
    case 'totalSum':
      return agg ? moneyCell(agg.totalSum) : null;
    default:
      return null;
  }
}
