import { Tooltip, Typography } from 'antd';
import { stringSorter } from './tableSorters';
import { shortenCounterpartyName } from '../utils/companyShortName';

// Колонки сторон документа — один набор для всех таблиц, где показывается УПД:
// «Документы», «Ожидаемые» в Операциях, обе истории и модалка привязки.
//
// Раньше набор расходился по экранам: список Документов показывал три стороны из
// шапки УПД, а Операции — пару «Поставщик / Подрядчик», и один и тот же документ
// выглядел на двух экранах по-разному.
//
// Две группы с разным смыслом, и порядок это подчёркивает:
//   Покупатель · Грузополучатель · Поставщик — что НАПИСАНО в документе
//                                              (графы 6, 4 и 2 формы 1137);
//   Подрядчик                                — с кем документ СВЯЗАН: от этого
//                                              поля зависят ярлык «Черновик»,
//                                              видимость роли contractor и
//                                              подбор документа к приёмке.
//
// Значения обычно совпадают: подрядчика подставляет резолвер по ИНН покупателя.
// Расходятся они там, где УПД выписан на генподрядчика, а материалы принимает
// субподрядчик, — и увидеть это можно только рядом стоящими колонками.

export type DocumentParties = {
  supplierName?: string | null;
  buyerName?: string | null;
  consigneeName?: string | null;
  contractorName?: string | null;
  recipientMolName?: string | null;
  recipientSource?: 'manual' | 'auto_buyer' | null;
};

/** Колонка antd в минимальной форме — таблицы типизируют строки по-своему. */
type PartyColumn<T> = {
  title: string;
  key: string;
  sorter: ReturnType<typeof stringSorter<T>>;
  render: (_: unknown, r: T) => React.ReactNode;
};

/**
 * Подрядчик документа. Показывает МОЛ, когда получатель — материально
 * ответственное лицо: заголовок остаётся «Подрядчик», потому что это же слово
 * стоит в фильтре шапки, а МОЛ-получателей на проде пока нет ни одного.
 *
 * Автоподстановку помечаем подсказкой, а не отдельной колонкой: менеджеру важно
 * знать, что значение пришло из документа и его стоит сверить с «Покупателем»,
 * но занимать этим ширину таблицы не за что.
 */
export function contractorColumn<T>(get: (r: T) => DocumentParties): PartyColumn<T> {
  return {
    title: 'Подрядчик',
    key: 'contractor',
    sorter: stringSorter<T>((r) => get(r).contractorName ?? get(r).recipientMolName ?? null),
    render: (_: unknown, r: T) => {
      const p = get(r);
      const name = p.contractorName ?? p.recipientMolName ?? null;
      if (!name) return '—';
      const text = shortenCounterpartyName(name);
      if (p.recipientSource !== 'auto_buyer') return text;
      return (
        <Tooltip title="Подставлено автоматически из покупателя документа. Проверьте, если поставка для субподрядчика.">
          <Typography.Text type="secondary" style={{ borderBottom: '1px dashed currentColor' }}>
            {text}
          </Typography.Text>
        </Tooltip>
      );
    },
  };
}

/**
 * Полный набор: три распознанные стороны + подрядчик.
 *
 * `get` вытаскивает стороны из строки таблицы: в списке документов они лежат
 * прямо в строке, в историях операций — внутри primarySourceDocument.
 */
export function documentPartyColumns<T>(get: (r: T) => DocumentParties): PartyColumn<T>[] {
  const party = (title: string, key: string, field: keyof DocumentParties): PartyColumn<T> => ({
    title,
    key,
    sorter: stringSorter<T>((r) => (get(r)[field] as string | null | undefined) ?? null),
    // shortenCounterpartyName сам отдаёт «—» на пустом значении.
    render: (_: unknown, r: T) =>
      shortenCounterpartyName((get(r)[field] as string | null | undefined) ?? null),
  });

  return [
    party('Покупатель', 'buyer', 'buyerName'),
    party('Грузополучатель', 'consignee', 'consigneeName'),
    party('Поставщик', 'supplier', 'supplierName'),
    contractorColumn<T>(get),
  ];
}
