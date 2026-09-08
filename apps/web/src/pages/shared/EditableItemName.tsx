import { useRef } from 'react';
import { Input, Tooltip, Typography } from 'antd';
import { EditOutlined } from '@ant-design/icons';

/**
 * Название позиции операции с видимым признаком правки.
 *
 * Правка названия существовала и раньше — по клику по тексту, — но выглядела
 * ячейка как обычный текст, и догадаться о ней было нельзя: за 90 дней из 8106
 * позиций, приехавших из документов, переименовали ровно одну. Отсюда карандаш,
 * подчёркивание на наведении и подсказка.
 *
 * Один компонент на четыре места (таблица и карточный режим × приёмка и
 * отгрузка): четыре копии уже разъехались по правилам блокировки.
 *
 * Режим правки держит вызывающий (`editing`/`onStartEdit`/`onStopEdit`), а не
 * локальный useState: гидратация формы пересоздаёт clientKey строк, и
 * внутреннее состояние пережило бы смену данных, оставшись открытым на чужой
 * строке.
 */
export function EditableItemName({
  value,
  onChange,
  disabledReason,
  variant = 'table',
  editing,
  onStartEdit,
  onStopEdit,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Причина, по которой правка недоступна; null — можно править. */
  disabledReason: string | null;
  variant?: 'table' | 'card';
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
}) {
  // Значение на входе в правку — для отката по Escape.
  const beforeEditRef = useRef(value);

  if (disabledReason) {
    return (
      <Tooltip title={disabledReason}>
        <div style={{ whiteSpace: 'pre-wrap', minHeight: 22, padding: '4px 0' }}>
          {value || <Typography.Text type="secondary">—</Typography.Text>}
        </div>
      </Tooltip>
    );
  }

  if (editing) {
    return (
      <>
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 6 }}
          autoFocus
          value={value}
          placeholder="Наименование"
          onChange={(e) => onChange(e.target.value)}
          onBlur={onStopEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onChange(beforeEditRef.current);
              onStopEdit();
            }
          }}
        />
        {/* Автосохранения в карточке нет. Без этой строки человек уходит со
            страницы, считая правку записанной. */}
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Применится после «Сохранить»
        </Typography.Text>
      </>
    );
  }

  const start = () => {
    beforeEditRef.current = value;
    onStartEdit();
  };

  return (
    <Tooltip title="Нажмите, чтобы исправить название" mouseEnterDelay={0.5}>
      <div
        className="matcheck-editable"
        role="button"
        tabIndex={0}
        aria-label={`Название: ${value || 'не заполнено'}. Нажмите, чтобы изменить`}
        onClick={start}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            start();
          }
        }}
        style={{
          whiteSpace: 'pre-wrap',
          minHeight: 22,
          padding: '4px 0',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
          fontWeight: variant === 'card' ? 500 : undefined,
        }}
      >
        <span style={{ flex: 1 }}>
          {value || (
            <Typography.Text type="secondary">— нажмите, чтобы заполнить —</Typography.Text>
          )}
        </span>
        {/* Иконка видна всегда, а не по hover: карточный режим — планшет, где
            наведения не существует. */}
        <EditOutlined style={{ color: '#d9d9d9', marginTop: 4 }} />
      </div>
    </Tooltip>
  );
}
