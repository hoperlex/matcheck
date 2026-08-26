import { Tag, Tooltip } from 'antd';
import type { ReactElement } from 'react';

export type ActiveFilterChip = {
  /** Ключ параметра — он же React key. */
  key: string;
  /** Что показать: «Статус: Оформлена». */
  label: string;
  /** Полный текст в подсказке, если label обрезан. */
  title?: string;
  onClear: () => void;
};

/**
 * Ряд чипов «что сейчас применено» — для фильтров, у которых нет своего
 * контрола на панели.
 *
 * Часть параметров живёт только в адресе: `?status=` остался от старой ссылки,
 * `?nophoto=1` приходит дип-линком из «Статистики». Список они сужают, а UI об
 * этом молчал — человек видел неполную таблицу и не понимал, почему. Чип
 * показывает такой фильтр и даёт его снять.
 *
 * Пустой список не рисует ничего (включая отступ), поэтому геометрия панели без
 * активных фильтров не меняется.
 */
export function ActiveFilterChips({
  items,
}: {
  items: ReadonlyArray<ActiveFilterChip>;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
      {items.map((chip) => (
        <Tooltip key={chip.key} title={chip.title ?? chip.label}>
          <Tag
            closable
            onClose={(e) => {
              e.preventDefault();
              chip.onClear();
            }}
            color="blue"
            style={{
              maxWidth: 260,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginInlineEnd: 0,
            }}
          >
            {chip.label}
          </Tag>
        </Tooltip>
      ))}
    </div>
  );
}
