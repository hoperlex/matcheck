import type { ReactNode } from 'react';

/** Высота кнопки antd по умолчанию — строка не ниже неё и с легендой. */
const ROW_HEIGHT = 32;

/**
 * Строка над таблицей: «Обозначения», а пока отмечены строки — массовые
 * действия на их месте.
 *
 * Высота строки постоянна, поэтому отметка строки таблицы ничего не сдвигает:
 * курсор остаётся на той же галочке, и можно отмечать следующую. Раньше
 * действия выводились в шапку страницы, там не помещались, переносились
 * второй строкой и опускали таблицу.
 */
export function LegendOrBulkBar({
  actions,
  legend,
}: {
  /** null — ничего не отмечено, видна легенда. */
  actions: ReactNode;
  legend: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', minHeight: ROW_HEIGHT }}>
      {actions ?? legend}
    </div>
  );
}
