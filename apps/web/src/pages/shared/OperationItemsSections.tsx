import { Button, Collapse, Popconfirm, Space, Typography, type TableProps } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMemo, type ReactNode } from 'react';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { useAutoOpenKeys } from '../../shared/hooks/useAutoOpenKeys';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import {
  buildItemSections,
  NO_DOCUMENT_SECTION_KEY,
  type ItemSection,
} from '../../shared/utils/operationItemSections';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';

/**
 * Материалы операции блоками — по одному на документ поставки.
 *
 * В поставке бывает несколько УПД и накладных, и раньше их позиции лежали одним
 * плоским списком: понять, какая строка из какой бумаги, было нельзя. Теперь у
 * каждого документа свой сворачиваемый блок с номером в заголовке — так же, как
 * сворачиваются «Фото».
 *
 * Строки при этом остаются ОДНИМ плоским массивом в state страницы: сохранение
 * устроено как DELETE + INSERT всего списка, и любая посекционная сборка
 * означала бы риск потерять строку вместе с данными в БД. Здесь только
 * группировка при рендере.
 */

type RowBase = {
  clientKey: string;
  sourceDocumentId: string | null;
  // Ключ подсветки: сверка адресует строку id позиции ДОКУМЕНТА, а не номером
  // строки операции — та нумерует свои позиции сама.
  sourceDocumentItemId?: string | null;
};

function sectionTitle<T extends RowBase>(section: ItemSection<T>, hasDocuments: boolean): string {
  const count = section.items.length;
  if (section.document) {
    const kind = sourceKindLabel(section.document.kind);
    const number = section.document.docNumber ? `№ ${section.document.docNumber}` : 'без номера';
    // Отвязанный документ остаётся подписью блока, если строки оставили при
    // отвязке: без подписи было бы непонятно, откуда они.
    const prefix = section.document.linked ? '' : 'отвязан ';
    // Недобор позиций виден прямо в заголовке. На приёмке 13157 в УПД было три
    // позиции, а доехали две — и счётчик «(2)» выглядел так, будто столько и
    // было. Показываем «N из M» только при недоборе: у здорового документа
    // лишняя дробь в заголовке — шум.
    const total = section.document.itemsCount;
    const covered = section.document.coveredItemsCount;
    const short = total != null && covered != null && covered < total;
    const counter = short ? `${covered} из ${total}` : `${count}`;
    return `Материалы · ${prefix}${kind} ${number} (${counter})`;
  }
  if (section.unknownDocumentId) {
    return `Материалы · документ ${section.unknownDocumentId.slice(0, 8)} (${count})`;
  }
  return hasDocuments ? `Материалы · без привязки к документу (${count})` : `Материалы (${count})`;
}

export function OperationItemsSections<T extends RowBase>({
  items,
  documents,
  columns,
  cardRender,
  onAddItem,
  onRemoveSection,
  emptyHint,
  problemItemIds,
  sectionExtra,
  renderSectionBody,
  sectionLabel,
  autoOpenKeys,
}: {
  items: T[];
  /** Сводка документов операции: связанные и оставшиеся в происхождении строк. */
  documents: OperationSourceDocument[];
  columns: NonNullable<TableProps<T>['columns']>;
  /** Второй аргумент — номер строки внутри блока (нумерация как в самой бумаге). */
  cardRender: (row: T, displayNo: number) => ReactNode;
  /**
   * Добавление строки в блок. undefined — прав на правку нет, кнопок не будет.
   * Аргумент — происхождение новой строки; сервер примет его только для
   * связанного документа, поэтому у отвязанных и неизвестных кнопки нет.
   */
  onAddItem?: (sourceDocumentId: string | null) => void;
  /**
   * Убрать из формы все строки блока отвязанного документа — для строк,
   * оставленных при отвязке. Применяется обычным «Сохранить», как удаление
   * строки корзиной. undefined — прав на правку нет, кнопки не будет.
   */
  onRemoveSection?: (sourceDocumentId: string) => void;
  /** Подсказка в блоке, когда позиций нет вовсе. */
  emptyHint: ReactNode;
  /**
   * Позиции документов, у которых сверка нашла проблему. Подсвечиваются строки,
   * чей `sourceDocumentItemId` попал в набор; пустой набор — подсветки нет.
   */
  problemItemIds?: ReadonlySet<string>;
  /**
   * Дополнительное содержимое заголовка блока, перед «Материал» — например,
   * привязанная к блоку УПД из ЭДО. Клики внутри блок не сворачивают.
   */
  sectionExtra?: (section: ItemSection<T>) => ReactNode;
  /**
   * Обёртка тела блока: получает готовую таблицу позиций (или подсказку, если
   * позиций нет) и может поставить что-то над ней — например, строки УПД из
   * ЭДО, а таблицу убрать в подблок. Без пропа тело — сама таблица.
   */
  renderSectionBody?: (section: ItemSection<T>, table: ReactNode) => ReactNode;
  /** Свой заголовок блока; второй аргумент — заголовок по умолчанию. */
  sectionLabel?: (section: ItemSection<T>, defaultLabel: string) => ReactNode;
  /**
   * Блоки, которые раскрываются сами — один раз, когда ключ впервые появился;
   * дальше блоком управляет человек. Без пропа все блоки свёрнуты.
   */
  autoOpenKeys?: readonly string[];
}) {
  const sections = useMemo(() => buildItemSections<T>({ items, documents }), [items, documents]);

  // Раскрытые блоки помним по id документа, а не по индексу или clientKey:
  // поллинг карточки перегидратирует форму (у confirmed_mol — на каждый новый
  // updatedAt) и генерирует новые clientKey, а привязка документа меняет состав
  // блоков. По ключу-документу состояние это переживает.
  const [openKeys, setOpenKeys] = useAutoOpenKeys(autoOpenKeys);

  const hasDocuments = documents.length > 0;

  return (
    <Collapse
      size="small"
      activeKey={openKeys}
      onChange={(keys) => setOpenKeys(Array.isArray(keys) ? keys : [keys])}
      items={sections.map((section) => {
        // Добавлять строку можно в блок связанного документа и в блок «без
        // привязки». В отвязанный и неизвестный — нельзя: сервер отбросит
        // происхождение, и строка молча уехала бы в «без привязки».
        const canAdd =
          onAddItem !== undefined &&
          (section.document?.linked === true || section.key === NO_DOCUMENT_SECTION_KEY);
        const displayNoByKey = new Map(section.items.map((row, idx) => [row.clientKey, idx + 1]));
        const addButton = canAdd ? (
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={(e) => {
              // Иначе клик по кнопке заодно свернёт/развернёт блок.
              e.stopPropagation();
              const target = section.document?.id ?? null;
              onAddItem(target);
              setOpenKeys((prev) => (prev.includes(section.key) ? prev : [...prev, section.key]));
            }}
          >
            Материал
          </Button>
        ) : null;
        const unlinkedDocId =
          section.document && !section.document.linked && section.items.length > 0
            ? section.document.id
            : null;
        const removeButton =
          onRemoveSection && unlinkedDocId ? (
            <Popconfirm
              title={`Удалить все строки блока (${section.items.length})?`}
              description="Изменение применится после сохранения."
              okText="Удалить"
              cancelText="Отмена"
              okButtonProps={{ danger: true }}
              onConfirm={() => onRemoveSection(unlinkedDocId)}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                Удалить материалы
              </Button>
            </Popconfirm>
          ) : null;
        const extraContent = sectionExtra?.(section);
        const defaultLabel = sectionTitle(section, hasDocuments);
        const table =
          section.items.length === 0 ? (
            <Typography.Text type="secondary">
              {section.document ? 'В этом документе не распознано ни одной позиции.' : emptyHint}
            </Typography.Text>
          ) : (
            <ResponsiveTable<T>
              items={section.items}
              columns={columns}
              rowKey="clientKey"
              // Один и тот же класс, что у карточки документа: подсветка
              // «этой строке не верь» должна выглядеть одинаково в обоих
              // местах, иначе она читается как два разных сигнала.
              rowClassName={(row) =>
                row.sourceDocumentItemId && problemItemIds?.has(row.sourceDocumentItemId)
                  ? 'matcheck-row-mismatch'
                  : ''
              }
              cardRender={(row) => cardRender(row, displayNoByKey.get(row.clientKey) ?? 1)}
              // Блоков на экране несколько, и собственный «во весь экран»
              // скролл у каждого превратил бы карточку в набор окон.
              scrollY={false}
              pagination={{ pageSize: 100, showSizeChanger: false, hideOnSinglePage: true }}
            />
          );
        return {
          key: section.key,
          label: sectionLabel ? sectionLabel(section, defaultLabel) : defaultLabel,
          extra:
            extraContent || addButton || removeButton ? (
              // Клик в заголовке переключает блок, а всплывающие подтверждения
              // живут в портале, но их события всё равно всплывают сюда.
              <span onClick={(e) => e.stopPropagation()}>
                <Space size={4} wrap>
                  {extraContent}
                  {addButton}
                  {removeButton}
                </Space>
              </span>
            ) : undefined,
          children: renderSectionBody ? renderSectionBody(section, table) : table,
        };
      })}
    />
  );
}
