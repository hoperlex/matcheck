import { Table } from 'antd';
import type { SourceDocumentDetail } from '@matcheck/contracts';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { formatMoneyRu } from '../../shared/utils/formatRu';
import { priceWithVat } from '../../shared/utils/priceWithVat';
import { useColumnTools, type ToolColumn } from '../../shared/ui/columnTools';

type Item = SourceDocumentDetail['items'][number];

/**
 * Позиции документа в режиме чтения.
 *
 * Вынесено из SourceDocumentDetailModal, чтобы теми же колонками показывать
 * распознанные строки рядом с оригиналом в карточке приёмки.
 */
export function SourceDocumentItemsTable({
  items,
  showInvNumber,
  withVat,
  docTotalSum,
  docVatSum,
}: {
  items: Item[];
  showInvNumber?: boolean;
  /**
   * Показывать цену С НАЛОГОМ. Только для УПД: там рядом стоит сумма из графы 9
   * (с налогом), и цена без налога из графы 4 не сходилась с ней на экране —
   * 15 × 240 против показанных 4 392. У накладных и ОС-2 колонка прежняя.
   */
  withVat?: boolean;
  /** Шапка документа — из неё берётся ставка для строк, где она не распозналась. */
  docTotalSum?: string | null;
  docVatSum?: string | null;
}) {
  // Колонка «Инв.№» отображается только для ОС-2 (kind='os2_transfer') —
  // у ТН и УПД она была бы пустой.
  const columns: ToolColumn<Item>[] = [
    // Номер позиции — только сортировка: фильтр по номерам строк не нужен.
    { title: '№', dataIndex: 'lineNo', width: 50, tools: { filter: false } },
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
      // Ширины Кол-во / Ед. / Цена — под подпись со стрелкой и воронкой в одну строку.
      width: 110,
      render: (v: string | null) => formatDecimal(v),
    },
    { title: 'Ед.', dataIndex: 'unit', width: 80 },
    {
      // Заголовок называет величину прямо: в приёмке цена остаётся без налога,
      // и одинаковое имя над разными числами читалось бы как расхождение.
      title: withVat ? 'Цена с НДС' : 'Цена',
      dataIndex: 'price',
      width: 150,
      render: (v: string | null, r: Item) =>
        formatMoneyRu(withVat ? priceWithVat(v, r.vatRate, docTotalSum, docVatSum) : v),
      // Сортируем по той цене, что видна (с налогом у УПД), а не по сырой.
      tools: {
        sortValue: (r) => {
          const v = withVat ? priceWithVat(r.price, r.vatRate, docTotalSum, docVatSum) : r.price;
          return v == null || v === '' ? null : Number(v);
        },
      },
    },
    {
      title: 'Сумма',
      dataIndex: 'sum',
      width: 150,
      render: (v: string | null) => formatMoneyRu(v),
    },
  );
  // Позиции документа приходят все — сортировка и фильтр в колонках.
  const tools = useColumnTools<Item>({ columns, items, enabled: true });
  return (
    <Table<Item>
      dataSource={items}
      rowKey="id"
      size="small"
      pagination={false}
      showSorterTooltip={false}
      // scroll={y} убран — давал внутренний tbody-скролл поверх скролла
      // Splitter.Panel. Тaблица растягивается по содержимому, скроллит
      // только внешняя панель.
      columns={tools.columns}
      onChange={tools.onChange}
    />
  );
}
