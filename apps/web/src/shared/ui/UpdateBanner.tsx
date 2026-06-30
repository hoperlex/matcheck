import { useState } from 'react';
import { Button, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useUpdatePrompt } from '../../lib/useUpdatePrompt';

/**
 * Закреплённый снизу баннер «Доступна новая версия портала».
 * Появляется, когда vite-plugin-pwa нашёл новый service worker
 * в waiting (после deploy на сервере и периодического update-poll'а
 * в useUpdatePrompt).
 *
 * UX:
 *  - position: fixed bottom-center, поверх контента, но НЕ перекрывает
 *    UI снизу-справа (FAB-чат, install-prompt PWA, antd Modal-кнопки,
 *    которые обычно живут справа).
 *  - z-index 1100 — выше antd Modal (1000) и Popover (1030), но ниже
 *    antd Message (1010+) и Notification (1010+); это компромисс,
 *    чтобы баннер был виден поверх обычной таблицы / редактирования,
 *    но не накрывал alert'ы об ошибках API.
 *  - На узких экранах (<640 px) сжимаем содержимое в столбик.
 *
 * Безопасность:
 *  - applyUpdate() делает одну активацию SW + один reload (плагин
 *    сам обрабатывает controllerchange). Никаких ручных
 *    location.reload в цикле.
 *  - dismiss() закрывает баннер до следующего обнаружения update
 *    (например, до следующего часа поллинга или открытия новой
 *    вкладки) — это полезно, если пользователь сейчас в середине
 *    редактирования и не готов перезагружаться.
 */
export function UpdateBanner(): JSX.Element | null {
  const { needRefresh, applyUpdate, dismiss } = useUpdatePrompt();
  const [applying, setApplying] = useState(false);
  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        zIndex: 1100,
        maxWidth: 'calc(100vw - 32px)',
        padding: '10px 16px',
        background: '#fff',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0, 0, 0, 0.12)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      <Typography.Text strong>Доступна новая версия портала</Typography.Text>
      <Space size="small" wrap>
        <Button size="small" onClick={dismiss} disabled={applying}>
          Позже
        </Button>
        <Button
          type="primary"
          size="small"
          icon={<ReloadOutlined />}
          loading={applying}
          onClick={() => {
            // Сразу показываем «Обновляю…» и блокируем повтор: reload произойдёт
            // по controllerchange или fallback-таймеру внутри applyUpdate.
            setApplying(true);
            applyUpdate();
          }}
        >
          {applying ? 'Обновляю…' : 'Обновить'}
        </Button>
      </Space>
    </div>
  );
}
