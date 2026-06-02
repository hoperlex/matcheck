import { Button, Popconfirm, Space, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';

/**
 * Inline-вариант bulk-actions: «Выбрано: N | [Удалить] [Снять]».
 * Предназначен для встраивания в существующую панель (шапку страницы,
 * tabBarExtraContent, и т.п.). НЕ боксовый — без своих фонов/рамок,
 * наследует layout родителя.
 *
 * Вариант с боксом — см. BulkActionBar.tsx (нужен, когда нет
 * подходящего toolbar в шапке и надо отдельной строкой над таблицей).
 *
 * Для inline-варианта важно: ничего НЕ рендерим при selectedCount===0,
 * чтобы родительский Space сжимался и не оставлял пустого места.
 */
export function BulkActionInline({
  selectedCount,
  onClear,
  onDelete,
  deleting,
  confirmTitle,
}: {
  selectedCount: number;
  onClear: () => void;
  onDelete: () => void;
  deleting?: boolean;
  /** Полный текст подтверждения, например «Удалить 3 контрагента?» */
  confirmTitle: string;
}) {
  if (selectedCount === 0) return null;
  return (
    <Space size={8}>
      <Typography.Text type="secondary">
        Выбрано: <b>{selectedCount}</b>
      </Typography.Text>
      <Popconfirm
        title={confirmTitle}
        okText="Удалить"
        cancelText="Отмена"
        okButtonProps={{ danger: true, loading: deleting }}
        onConfirm={onDelete}
        placement="bottomRight"
      >
        <Button danger icon={<DeleteOutlined />} loading={deleting}>
          Удалить выбранные
        </Button>
      </Popconfirm>
      <Button onClick={onClear} disabled={deleting}>
        Снять выбор
      </Button>
    </Space>
  );
}
