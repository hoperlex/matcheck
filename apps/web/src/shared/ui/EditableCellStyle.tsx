/**
 * Признак «эту ячейку можно править».
 *
 * Инлайн-стиль, а не CSS-файл: их в проекте нет ни одного, и заводить первый
 * ради трёх правил незачем (тот же приём — MismatchRowStyle).
 *
 * Подчёркивание появляется на наведении, а иконка карандаша видна всегда:
 * карточный режим — это планшет, где hover не существует вовсе, а именно там
 * названия и правят чаще всего.
 */
export function EditableCellStyle() {
  return (
    <style>{`
      .matcheck-editable { cursor: text; border-bottom: 1px dashed transparent; }
      .matcheck-editable:hover { border-bottom-color: #d9d9d9; }
      .matcheck-editable:hover .anticon-edit,
      .matcheck-editable:focus-visible .anticon-edit { color: #1677ff; }
    `}</style>
  );
}
