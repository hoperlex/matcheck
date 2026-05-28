import { Tabs } from 'antd';

/**
 * Тонкая обёртка над antd Tabs для верхней панели страниц. Принимает
 * элементы с опциональным `count` — рендерится как «Имя (N)», совпадая
 * со стилем эталонного UI «Все (490) / На согласование (28) …».
 * Если count = null/undefined — подпись без скобок (счётчик ещё грузится
 * или не нужен).
 */
export interface PageTabItem {
  key: string;
  label: string;
  count?: number | null;
}

export function PageTabs({
  items,
  activeKey,
  onChange,
}: {
  items: PageTabItem[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <Tabs
      activeKey={activeKey}
      onChange={onChange}
      items={items.map((it) => ({
        key: it.key,
        label: it.count == null ? it.label : `${it.label} (${it.count})`,
      }))}
      style={{ marginBottom: 0 }}
    />
  );
}
