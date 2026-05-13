import { useEffect, useState } from 'react';
import { Button, Card, Form, Select, Space, Typography, message } from 'antd';
import { getSetting, setSetting } from '../../lib/db';
import { runSync } from '../../services/sync';
import { usePwaInstall } from '../../lib/usePwaInstall';

type RetentionMode = 'all' | 'from_date' | 'none';

export default function SettingsPage() {
  const [retention, setRetention] = useState<RetentionMode>('all');
  const { canInstall, promptInstall } = usePwaInstall();

  useEffect(() => {
    void getSetting<RetentionMode>('retention_mode').then((v) => {
      if (v) setRetention(v);
    });
  }, []);

  const save = async () => {
    await setSetting('retention_mode', retention);
    message.success('Настройки сохранены');
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>Настройки</Typography.Title>
      <Card title="Хранение данных на устройстве" size="small">
        <Form layout="vertical">
          <Form.Item label="Что хранить локально">
            <Select<RetentionMode>
              value={retention}
              onChange={setRetention}
              options={[
                { value: 'all', label: 'Все данные (без ограничений)' },
                { value: 'from_date', label: 'Только последние' },
                { value: 'none', label: 'Только мои текущие приёмки' },
              ]}
            />
          </Form.Item>
          <Button type="primary" onClick={save}>
            Сохранить
          </Button>
        </Form>
      </Card>
      <Card title="Синхронизация" size="small">
        <Button onClick={() => void runSync()}>Синхронизировать сейчас</Button>
      </Card>
      <Card title="Установка приложения" size="small">
        {canInstall ? (
          <Button type="primary" onClick={() => void promptInstall()}>
            Установить на устройство
          </Button>
        ) : (
          <Typography.Text type="secondary">
            Приложение либо уже установлено, либо браузер не поддерживает установку PWA. Используйте
            «Добавить на главный экран» в меню браузера.
          </Typography.Text>
        )}
      </Card>
    </Space>
  );
}
