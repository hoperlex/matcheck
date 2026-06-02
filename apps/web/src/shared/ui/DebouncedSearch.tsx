import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * Универсальное поле текстового поиска с debounce.
 *
 * Поведение:
 *  - Пользователь печатает → значение мгновенно отображается в поле.
 *  - После паузы 300 мс (без новых нажатий) — вызывает onChange(value)
 *    и родитель использует это как новое значение фильтра.
 *  - Очистка (allowClear) — onChange срабатывает мгновенно без debounce,
 *    чтобы фильтр не «застревал» после X.
 *
 * Подменяет antd Input.Search, который реагировал только на Enter или
 * клик по иконке-лупе — пользователям непривычно, ожидают автопоиск.
 */
export function DebouncedSearch({
  value,
  onChange,
  placeholder,
  style,
  delayMs = 300,
}: {
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  /** Задержка между набором и колбэком, мс. По умолчанию 300. */
  delayMs?: number;
}) {
  const [local, setLocal] = useState(value ?? '');
  // Чтобы не дёргать onChange на каждый рендер, который пришёл от родителя
  // (например, после reset фильтров) — синхронизируем local, когда внешний
  // value существенно отличается. Локальный ввод пользователя
  // (`isTyping.current`) не перетирается.
  const isTyping = useRef(false);
  useEffect(() => {
    if (!isTyping.current) setLocal(value ?? '');
  }, [value]);

  useEffect(() => {
    if (!isTyping.current) return;
    const t = setTimeout(() => {
      onChange(local);
      isTyping.current = false;
    }, delayMs);
    return () => clearTimeout(t);
  }, [local, delayMs, onChange]);

  return (
    <Input
      style={style}
      placeholder={placeholder}
      value={local}
      allowClear
      prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
      onChange={(e) => {
        isTyping.current = true;
        setLocal(e.target.value);
        // Очистку (кнопка X) применяем немедленно, без debounce —
        // иначе фильтр продолжает удерживать старое значение пока тикает таймер.
        if (e.target.value === '') {
          isTyping.current = false;
          onChange('');
        }
      }}
    />
  );
}
