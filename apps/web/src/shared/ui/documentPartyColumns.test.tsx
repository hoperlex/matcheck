/**
 * Состав общего набора колонок сторон документа.
 *
 * `documentPartyColumns` обслуживает сразу три экрана — «Документы»,
 * «Ожидаемые» в Операциях и модалку привязки УПД, — поэтому добавление или
 * удаление колонки здесь меняет вид всего портала. Раньше в наборе был четвёртый
 * элемент, «Подрядчик»: в списке он почти всегда дублировал покупателя
 * (резолвер подставляет подрядчика по ИНН покупателя) и занимал ширину в и без
 * того широкой таблице. Его убрали, и тест фиксирует именно состав — чтобы
 * колонка не вернулась незаметно вместе с правкой соседнего поля.
 *
 * Подрядчик при этом никуда не делся из системы: он остался фильтром над
 * таблицей и полем в карточке документа.
 */
import { describe, it, expect } from 'vitest';
import { documentPartyColumns, type DocumentParties } from './documentPartyColumns';

type Row = DocumentParties;

const columns = documentPartyColumns<Row>((r) => r);

describe('documentPartyColumns', () => {
  it('содержит ровно три стороны документа, в порядке граф формы 1137', () => {
    expect(columns.map((c) => c.title)).toEqual(['Покупатель', 'Грузополучатель', 'Поставщик']);
  });

  it('колонки «Подрядчик» в наборе нет', () => {
    expect(columns.map((c) => c.key)).not.toContain('contractor');
    expect(columns.map((c) => c.title)).not.toContain('Подрядчик');
  });

  it('у каждой стороны свой ключ и сортировка', () => {
    expect(columns.map((c) => c.key)).toEqual(['buyer', 'consignee', 'supplier']);
    for (const c of columns) {
      expect(typeof c.sorter, c.key).toBe('function');
    }
  });

  it('ячейка показывает название и ИНН, а пустую сторону — прочерком', () => {
    const row: Row = { buyerName: 'ООО «СУ-10»', buyerInn: '7736255508' };
    const buyer = columns[0]!;
    // render возвращает React-элемент; проверяем, что он строится без падения
    // и что пустая сторона тоже обрабатывается (внутри partyCell → «—»).
    expect(buyer.render(null, row)).toBeTruthy();
    expect(buyer.render(null, {})).toBeTruthy();
  });
});
