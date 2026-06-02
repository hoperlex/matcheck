import { Button, Popconfirm, Space, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';

/**
 * Sticky-баннер над таблицей, появляется когда выбрана хотя бы одна
 * строка. Универсальный — каждая таблица передаёт count и onDelete.
 *
 * Стилистика подобрана под общий минимализм портала: лёгкая серая
 * заливка, тонкая граница, иконка корзины, primary-кнопка действия.
 * Подтверждение — antd Popconfirm с явным красным «Удалить N» и
 * отменой; модалка не используется (по требованию UX).
 */
export function BulkActionBar({
  selectedCount,
  onClear,
  onDelete,
  deleting,
  itemNoun,
}: {
  selectedCount: number;
  onClear: () => void;
  onDelete: () => void;
  deleting?: boolean;
  /** Единственное число существительного для счётчика — например «документ» */
  itemNoun?: string;
}) {
  if (selectedCount === 0) return null;
  const noun = itemNoun ?? 'строк';
  const plural = pluralize(selectedCount, noun);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 12px',
        marginBottom: 8,
        background: '#fafafa',
        border: '1px solid #f0f0f0',
        borderRadius: 6,
      }}
    >
      <Typography.Text>
        Выбрано: <b>{selectedCount}</b>
      </Typography.Text>
      <Space>
        <Popconfirm
          title={`Удалить ${selectedCount} ${plural}?`}
          okText="Удалить"
          cancelText="Отмена"
          okButtonProps={{ danger: true, loading: deleting }}
          onConfirm={onDelete}
          placement="topRight"
        >
          <Button danger icon={<DeleteOutlined />} loading={deleting}>
            Удалить выбранные
          </Button>
        </Popconfirm>
        <Button onClick={onClear} disabled={deleting}>
          Снять выбор
        </Button>
      </Space>
    </div>
  );
}

// Простейшее склонение для русского. Принимает базовое слово в им.п. ед.ч.
// (например «документ»). Возвращает форму, согласованную с числом:
// 1 документ / 2-4 документа / 5+ документов / 11-14 документов.
function pluralize(n: number, base: string): string {
  const last = n % 10;
  const lastTwo = n % 100;
  // Особый случай для тех баз, у которых форма не строится по правилу
  // (закрытие на согласный + -а/-ов). Базовых склонений в проекте мало,
  // ниже работает для «документ», «строка»→… (нужно передавать форму
  // ед.ч.; для женского рода передавать «строку» и расширить таблицу).
  if (lastTwo >= 11 && lastTwo <= 14) return `${base}ов`;
  if (last === 1) return base;
  if (last >= 2 && last <= 4) return `${base}а`;
  return `${base}ов`;
}
