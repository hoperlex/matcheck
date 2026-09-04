import { Space, Typography } from 'antd';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { UpdValidationSummary } from '../../shared/ui/UpdValidationSummary';
import { sourceKindLabel } from '../../shared/utils/sourceKindLabel';

/**
 * Сверка документа в карточке операции.
 *
 * Зачем она здесь, а не только в «Документах». Замечания вида «система подтянула
 * неверное кол-во» оставляет роль monitor, а `documents.list:view` есть только у
 * manager и contractor — уйти за подробностями в раздел «Документы» монитор не
 * может. За 30 дней 313 приёмок были построены на документе, о котором разбор
 * уже знал, что числа не сходятся, и 220 из них закрылись, ни разу не попав
 * человеку на глаза. Здесь этот сигнал наконец виден там, где принимают решение.
 *
 * Почему с числами и словами, а не одним значком: время от разбора документа до
 * «Подтвердить МОЛ» — в медиане 142 минуты, и за это время проверяющий должен
 * понять, что именно смотреть в бумаге, не открывая другой раздел.
 *
 * Блоки материалов по умолчанию свёрнуты, поэтому плашка обязана быть
 * самодостаточной: подсветка строк внутри блока сама по себе не видна.
 */
export function OperationDocumentValidationAlert({
  documents,
  itemNameByDocumentItemId,
}: {
  documents: OperationSourceDocument[];
  /**
   * Имена позиций операции по `sourceDocumentItemId` — чтобы назвать проблемную
   * строку словами, а не только номером. Строка без связи с документом сюда не
   * попадает: у 0,3% позиций происхождение обнулено переразбором.
   */
  itemNameByDocumentItemId?: ReadonlyMap<string, string>;
}) {
  const flagged = documents.filter((d) => d.validation !== undefined);
  if (flagged.length === 0) return null;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
      {flagged.map((doc) => {
        const v = doc.validation!;
        const number = doc.docNumber ? `№ ${doc.docNumber}` : 'без номера';
        const names = (v.problemItemIds ?? [])
          .map((id) => itemNameByDocumentItemId?.get(id))
          .filter((name): name is string => Boolean(name));
        return (
          <div key={doc.id}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              {sourceKindLabel(doc.kind)} {number}: сверьте с бумагой
            </Typography.Text>
            <UpdValidationSummary
              failedChecks={v.failedChecks}
              warnings={v.warnings}
              // Свой ключ на каждый документ: свёрнутость в карточке операции не
              // должна наследоваться от раздела «Документы» и наоборот.
              storageKey={`matcheck.operation.validation.${doc.id}`}
            />
            {names.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Проблемные позиции: {names.join(', ')}
              </Typography.Text>
            )}
          </div>
        );
      })}
    </Space>
  );
}
