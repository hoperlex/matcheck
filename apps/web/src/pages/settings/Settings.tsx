import { useEffect, useState } from 'react';
import { Button, Card, Form, Radio, Select, Space, Spin, Typography, message } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, UpdParseMode } from '@matcheck/contracts';
import { api } from '../../services/api';
import { getSetting, setSetting } from '../../lib/db';
import { runSync } from '../../services/sync';
import { usePwaInstall } from '../../lib/usePwaInstall';
import { usePermissions } from '../../shared/hooks/usePermissions';

type RetentionMode = 'all' | 'from_date' | 'none';

export default function SettingsPage() {
  const qc = useQueryClient();
  const [retention, setRetention] = useState<RetentionMode>('all');
  // Способ распознавания — серверная настройка (PUT /admin/settings). Просмотр
  // страницы можно выдать отдельно от правки, поэтому переключатель спрашивает
  // именно edit: иначе он выглядел бы рабочим и отвечал 403.
  const { can } = usePermissions();
  const canEditSettings = can('admin.settings', 'edit');
  const { canInstall, promptInstall } = usePwaInstall();

  useEffect(() => {
    void getSetting<RetentionMode>('retention_mode').then((v) => {
      if (v) setRetention(v);
    });
  }, []);

  const saveRetention = async () => {
    await setSetting('retention_mode', retention);
    message.success('Настройки сохранены');
  };

  const appSettingsQ = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<AppSettings>('/admin/settings'),
  });
  const saveParseMode = useMutation({
    mutationFn: (mode: UpdParseMode) =>
      api.put<AppSettings>('/admin/settings', { updParseMode: mode }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      message.success('Способ распознавания сохранён');
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Не удалось сохранить';
      message.error(msg);
    },
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>Настройки</Typography.Title>

      <Card title="Распознавание УПД-PDF" size="small">
        {appSettingsQ.isLoading ? (
          <Spin />
        ) : (
          <Form layout="vertical">
            <Form.Item label="Способ распознавания">
              <Radio.Group
                value={appSettingsQ.data?.updParseMode ?? 'llm'}
                onChange={(e) => saveParseMode.mutate(e.target.value as UpdParseMode)}
                disabled={saveParseMode.isPending || !canEditSettings}
                options={[
                  { value: 'llm', label: 'Через LLM (точнее, но медленно и расходует токены)' },
                  { value: 'local', label: 'Локально (быстро, без LLM)' },
                ]}
              />
            </Form.Item>
            <Typography.Text type="secondary">
              Локальный парсер работает на печатной форме УПД из постановления № 1137. Если не
              сможет распознать — предложит ре-распознать через LLM.
            </Typography.Text>
          </Form>
        )}
      </Card>

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
          <Button type="primary" onClick={saveRetention}>
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
