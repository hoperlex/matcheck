import { Spin, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { api } from '../../services/api';
import { formatDecimal } from '../utils/formatDecimal';
import { formatMoneyRu } from '../utils/formatRu';
import { priceWithVat } from '../utils/priceWithVat';

/**
 * Раскрывающаяся панель с позициями source_document. Lazy fetch:
 * запрос /source-documents/{id} выполняется только при первом раскрытии,
 * результат кешируется react-query — повторное раскрытие/сворачивание не
 * дёргает сеть.
 *
 * Для kind='os2_transfer' добавляется колонка «Инв.№» (инвентарный номер
 * основного средства). Для ТН и УПД её нет.
 */
export function ExpandedSourceDocumentItems({
  id,
  kind,
  withVat,
}: {
  id: string;
  kind: SourceDocumentDetail['kind'];
  /**
   * Показывать цену С НАЛОГОМ (только для УПД).
   *
   * По умолчанию выключено, и это важно: тот же компонент раскрывает строки
   * на КПП и в отгрузке, а там цена намеренно повторяет бланк — рядом стоит
   * своя колонка «Сумма НДС». Включается точечно, из списка «Документы».
   */
  withVat?: boolean;
}) {
  const { data, isLoading, error } = useQuery({
    // Тот же ключ, что у префетча списка и карточки документа: один и тот же
    // GET /source-documents/:id не должен грузиться трижды под разными именами.
    queryKey: ['source-document', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
  });

  if (isLoading) {
    return (
      <div style={{ padding: 12, textAlign: 'center' }}>
        <Spin size="small" />
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 12 }}>
        <Typography.Text type="danger">
          Не удалось загрузить позиции: {(error as Error).message}
        </Typography.Text>
      </div>
    );
  }
  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <div style={{ padding: 12 }}>
        <Typography.Text type="secondary">Позиций нет</Typography.Text>
      </div>
    );
  }

  const showInv = kind === 'os2_transfer';
  // Пересчёт только для УПД и только там, где его явно попросили.
  const showVat = withVat === true && kind === 'upd';
  type Item = (typeof items)[number];
  const columns: NonNullable<Parameters<typeof Table<Item>>[0]['columns']> = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    { title: 'Название', dataIndex: 'nameRaw' },
  ];
  if (showInv) {
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
      // В бланке УПД цены с налогом нет — она пересчитывается по ставке строки,
      // чтобы количество × цена сходилось с «Суммой» (графа 9).
      title: showVat ? 'Цена с НДС' : 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null, r: SourceDocumentDetail['items'][number]) =>
        formatMoneyRu(
          showVat ? priceWithVat(v, r.vatRate, data?.totalSum ?? null, data?.vatSum ?? null) : v,
        ),
    },
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      width: 120,
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      dataIndex: 'sum',
      width: 130,
      render: (v: string | null) => formatMoneyRu(v),
    },
  );

  return (
    <Table<Item>
      dataSource={items}
      columns={columns}
      rowKey="id"
      size="small"
      pagination={false}
      showSorterTooltip={false}
      style={{ background: 'transparent' }}
    />
  );
}
