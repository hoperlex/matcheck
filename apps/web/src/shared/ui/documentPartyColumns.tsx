import { Typography } from 'antd';
import { isPlaceholderInn } from '@matcheck/contracts';
import { stringSorter } from './tableSorters';
import { shortenCounterpartyName } from '../utils/companyShortName';

// Колонки сторон документа — один набор для всех таблиц, где показывается УПД:
// «Документы», «Ожидаемые» в Операциях, обе истории и модалка привязки.
//
// Раньше набор расходился по экранам: список Документов показывал три стороны из
// шапки УПД, а Операции — пару «Поставщик / Подрядчик», и один и тот же документ
// выглядел на двух экранах по-разному.
//
// Показываем то, что НАПИСАНО в документе: покупатель, грузополучатель и
// поставщик — графы 6, 4 и 2 формы 1137.
//
// Подрядчика в наборе НЕТ намеренно. Это поле не из документа, а связь с
// приёмкой, и в списке оно почти всегда дублировало покупателя: резолвер
// подставляет подрядчика по ИНН покупателя, а расходятся они лишь там, где УПД
// выписан на генподрядчика. Ради этого редкого случая колонка занимала ширину в
// и без того широкой таблице. Подрядчик остался фильтром над таблицей и полем в
// карточке документа — и, разумеется, продолжает работать в логике (ярлык
// «Черновик», видимость для роли contractor, подбор документа к приёмке).

export type DocumentParties = {
  supplierName?: string | null;
  buyerName?: string | null;
  consigneeName?: string | null;
  // ИНН сторон — вторая строка ячейки. Сервер отдаёт COALESCE(ИНН из
  // документа, ИНН справочной записи), так что здесь уже готовое значение.
  supplierInn?: string | null;
  buyerInn?: string | null;
  consigneeInn?: string | null;
};

/**
 * Колонка antd в минимальной форме — таблицы типизируют строки по-своему.
 *
 * width и ellipsis нужны сторонам с ИНН: ячейка двухстрочная, а ResponsiveTable
 * по умолчанию навешивает ellipsis на каждую колонку (одна строка + nowrap) и
 * схлопнул бы вторую строку.
 */
type PartyColumn<T> = {
  title: string;
  key: string;
  width?: number;
  ellipsis?: boolean | { showTitle: boolean };
  sorter: ReturnType<typeof stringSorter<T>>;
  render: (_: unknown, r: T) => React.ReactNode;
};

/** Ширина колонки стороны: под «ИНН 7712345678» второй строкой плюс отступы. */
const PARTY_WIDTH = 170;

/**
 * Ячейка стороны: название сверху, ИНН снизу — числитель и знаменатель.
 *
 * Вторая строка есть ВСЕГДА, даже когда ИНН неизвестен (тогда неразрывный
 * пробел): иначе строки таблицы получались бы разной высоты и список «прыгал»
 * бы при прокрутке. Плейсхолдерный ИНН (0000…, контрагент заведён на лету без
 * реквизитов) прячем — показывать его пользователю незачем.
 *
 * display:block + width:100% на обеих строках обязательны: Typography.Text —
 * инлайновый элемент, и его ellipsis без явной ширины срабатывает не всегда.
 */
export function partyCell(
  name: string | null | undefined,
  inn: string | null | undefined,
): React.ReactNode {
  const trimmedInn = inn?.trim();
  const shownInn = trimmedInn && !isPlaceholderInn(trimmedInn) ? trimmedInn : null;
  const innText = shownInn ? `ИНН ${shownInn}` : ' ';
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <Typography.Text
        style={{ display: 'block', width: '100%', fontSize: 13, lineHeight: 1.2 }}
        // Тултип с полным названием: в ячейке оно сокращено до ОПФ-префикса
        // (shortenCounterpartyName) и обрезано по ширине колонки.
        ellipsis={name ? { tooltip: name } : true}
      >
        {shortenCounterpartyName(name)}
      </Typography.Text>
      <Typography.Text
        type="secondary"
        style={{ display: 'block', width: '100%', fontSize: 11, lineHeight: 1.2 }}
        ellipsis={shownInn ? { tooltip: innText } : true}
      >
        {innText}
      </Typography.Text>
    </div>
  );
}

/**
 * Полный набор: три распознанные стороны документа.
 *
 * `get` вытаскивает стороны из строки таблицы: в списке документов они лежат
 * прямо в строке, в историях операций — внутри primarySourceDocument.
 */
export function documentPartyColumns<T>(get: (r: T) => DocumentParties): PartyColumn<T>[] {
  const party = (
    title: string,
    key: string,
    nameField: keyof DocumentParties,
    innField: keyof DocumentParties,
  ): PartyColumn<T> => ({
    title,
    key,
    width: PARTY_WIDTH,
    // Ячейка двухстрочная, поэтому общий ellipsis таблицы (он же nowrap на всю
    // ячейку) здесь выключен — обрезкой и тултипами занимается partyCell.
    ellipsis: false,
    sorter: stringSorter<T>((r) => (get(r)[nameField] as string | null | undefined) ?? null),
    // partyCell сам отдаёт «—» на пустом имени (через shortenCounterpartyName).
    render: (_: unknown, r: T) =>
      partyCell(
        get(r)[nameField] as string | null | undefined,
        get(r)[innField] as string | null | undefined,
      ),
  });

  return [
    party('Покупатель', 'buyer', 'buyerName', 'buyerInn'),
    party('Грузополучатель', 'consignee', 'consigneeName', 'consigneeInn'),
    party('Поставщик', 'supplier', 'supplierName', 'supplierInn'),
  ];
}
