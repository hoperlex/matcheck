import { Button } from 'antd';
import { ClearOutlined } from '@ant-design/icons';

/**
 * «Сбросить» — снять все фильтры списка разом.
 *
 * Фильтры теперь переживают уход из раздела (shared/listMemory), и прежний
 * «сброс» повторным кликом по меню больше ничего не стирает. Кнопка стоит на
 * панели ВСЕГДА — фиксированной ширины, без фильтров неактивна: появление и
 * исчезновение двигало бы соседние поля.
 */
export function ResetFiltersButton({
  onReset,
  disabled,
}: {
  onReset: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      icon={<ClearOutlined />}
      onClick={onReset}
      disabled={disabled}
      style={{ width: 116, flexShrink: 0 }}
    >
      Сбросить
    </Button>
  );
}
