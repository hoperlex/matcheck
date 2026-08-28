import { Button, Collapse, Typography, type TableProps } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMemo, useState, type ReactNode } from 'react';
import type { OperationSourceDocument } from '@matcheck/contracts';
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

type RowBase = { clientKey: string; sourceDocumentId: string | null };

function sectionTitle<T extends RowBase>(section: ItemSection<T>, hasDocuments: boolean): string {
  const count = section.items.length;
  if (section.document) {
    const kind = sourceKindLabel(section.document.kind);
    const number = section.document.docNumber ? `№ ${section.document.docNumber}` : 'без номера';
    // Отвязанный документ остаётся подписью блока: unlink-source намеренно не
    // трогает позиции, и без подписи было бы непонятно, откуда эти строки.
    const prefix = section.document.linked ? '' : 'отвязан ';
    return `Материалы · ${prefix}${kind} ${number} (${count})`;
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
  emptyHint,
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
  /** Подсказка в блоке, когда позиций нет вовсе. */
  emptyHint: ReactNode;
}) {
  const sections = useMemo(() => buildItemSections<T>({ items, documents }), [items, documents]);

  // Раскрытые блоки помним по id документа, а не по индексу или clientKey:
  // поллинг карточки перегидратирует форму (у confirmed_mol — на каждый новый
  // updatedAt) и генерирует новые clientKey, а привязка документа меняет состав
  // блоков. По ключу-документу состояние это переживает.
  const [openKeys, setOpenKeys] = useState<string[]>([]);

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
        return {
          key: section.key,
          label: sectionTitle(section, hasDocuments),
          extra: canAdd ? (
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
          ) : undefined,
          children:
            section.items.length === 0 ? (
              <Typography.Text type="secondary">
                {section.document ? 'В этом документе не распознано ни одной позиции.' : emptyHint}
              </Typography.Text>
            ) : (
              <ResponsiveTable<T>
                items={section.items}
                columns={columns}
                rowKey="clientKey"
                cardRender={(row) => cardRender(row, displayNoByKey.get(row.clientKey) ?? 1)}
                // Блоков на экране несколько, и собственный «во весь экран»
                // скролл у каждого превратил бы карточку в набор окон.
                scrollY={false}
                pagination={{ pageSize: 100, showSizeChanger: false, hideOnSinglePage: true }}
              />
            ),
        };
      })}
    />
  );
}
