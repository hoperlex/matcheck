import { useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MailAccountDto, MailAccountUpsert } from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';

/**
 * Ящики бывают двух назначений:
 *   - «Заявки» — исторический канал: письмо сразу разбирается LLM (кнопка
 *     «Синхронизировать», обрабатывает до 50 писем подряд, поэтому долгая);
 *   - «Документы» — УПД от подрядчиков: письма забирает отдельный процесс,
 *     кладёт в карантин и разбирает по коду объекта из письма.
 *
 * Опрос ящика с документами включается ОТДЕЛЬНО от активности: сначала ящик
 * заводят и проверяют доступы кнопкой «Проверить сейчас», и только потом
 * включают постоянный опрос.
 */
export default function AdminMailAccountsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<MailAccountUpsert>();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'mail-accounts'] });

  const list = useQuery({
    queryKey: ['admin', 'mail-accounts'],
    queryFn: () => api.get<MailAccountDto[]>('/admin/mail-accounts'),
  });
  const create = useMutation({
    mutationFn: (body: MailAccountUpsert) => api.post('/admin/mail-accounts', body),
    onSuccess: () => {
      message.success('Ящик добавлен');
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });
  const sync = useMutation({
    mutationFn: (id: string) =>
      // Sync почты обрабатывает до 50 сообщений последовательно с LLM — длиннее дефолта.
      api.post<{ imported: number; failed: number }>(`/admin/mail-accounts/${id}/sync`, undefined, {
        timeoutMs: 610_000,
      }),
    onSuccess: (r) => message.success(`Импорт: ${r.imported}, ошибок: ${r.failed}`),
    onError: (err: Error) => message.error(err.message),
  });
  // Опрос идёт в отдельном процессе, поэтому запрос лишь ставит задачу в
  // очередь и сразу возвращается — держать соединение десятки секунд незачем.
  const poll = useMutation({
    mutationFn: (id: string) =>
      api.post<{ queued: true; jobId: string }>(`/admin/mail-accounts/${id}/poll`),
    onSuccess: () =>
      message.success('Проверка запущена — письма появятся в разборе через несколько секунд'),
    onError: (err: Error) => message.error(err.message),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; pollEnabled: boolean }) =>
      api.patch(`/admin/mail-accounts/${v.id}`, { pollEnabled: v.pollEnabled }),
    onSuccess: (_r, v) => {
      message.success(v.pollEnabled ? 'Автоопрос включён' : 'Автоопрос выключен');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const isDocs = (r: MailAccountDto) => r.purpose === 'document';

  const actions = (r: MailAccountDto, size?: 'small') =>
    isDocs(r) ? (
      <Space size={8} wrap>
        <Button size={size} onClick={() => poll.mutate(r.id)} loading={poll.isPending}>
          Проверить сейчас
        </Button>
        <Tooltip
          title={
            r.pollEnabled
              ? 'Ящик опрашивается автоматически'
              : 'Включите, когда убедитесь, что доступы верны'
          }
        >
          <Switch
            size="small"
            checked={r.pollEnabled}
            loading={patch.isPending}
            onChange={(checked) => patch.mutate({ id: r.id, pollEnabled: checked })}
          />
        </Tooltip>
      </Space>
    ) : (
      <Button size={size} onClick={() => sync.mutate(r.id)} loading={sync.isPending}>
        Синхронизировать
      </Button>
    );

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Почтовые ящики
          </Typography.Title>
          <Button type="primary" onClick={() => setOpen(true)}>
            Добавить
          </Button>
        </Space>
      }
    >
      <ResponsiveTable<MailAccountDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Имя', dataIndex: 'name' },
          {
            title: 'Назначение',
            key: 'purpose',
            render: (_: unknown, r: MailAccountDto) =>
              isDocs(r) ? <Tag color="blue">Документы</Tag> : <Tag>Заявки</Tag>,
          },
          { title: 'Host', dataIndex: 'host' },
          { title: 'Пользователь', dataIndex: 'username' },
          { title: 'Папка', dataIndex: 'folder' },
          {
            title: 'Опрос',
            key: 'poll',
            render: (_: unknown, r: MailAccountDto) =>
              !isDocs(r) ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : r.pollEnabled ? (
                <Tag color="green">включён</Tag>
              ) : (
                <Tag>выключен</Tag>
              ),
          },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: MailAccountDto) => actions(r),
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space size={8}>
                <Typography.Text strong>{r.name}</Typography.Text>
                {isDocs(r) ? <Tag color="blue">Документы</Tag> : <Tag>Заявки</Tag>}
              </Space>
              <Typography.Text type="secondary">
                {r.username}@{r.host}:{r.port}
              </Typography.Text>
              {actions(r, 'small')}
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый ящик"
        width={480}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<MailAccountUpsert>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{
            port: 993,
            useTls: true,
            folder: 'INBOX',
            isActive: true,
            purpose: 'request',
            pollEnabled: false,
          }}
        >
          <Form.Item
            name="purpose"
            label="Назначение"
            tooltip="«Документы» — приём УПД от подрядчиков: письма попадают в разбор и распознаются автоматически"
          >
            <Segmented
              options={[
                { label: 'Заявки', value: 'request' },
                { label: 'Документы (УПД)', value: 'document' },
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label="Имя" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="host" label="IMAP host" rules={[{ required: true }]}>
            <Input placeholder="imap.yandex.ru" />
          </Form.Item>
          <Space>
            <Form.Item name="port" label="Port" rules={[{ required: true }]}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="useTls" label="TLS" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input placeholder="upd@company.ru" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true }]}
            tooltip="Для Яндекс 360 нужен пароль приложения, обычный пароль от аккаунта не подойдёт"
          >
            <Input.Password />
          </Form.Item>
          <Form.Item name="folder" label="Папка" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Автоопрос после создания выключен: сначала проверьте доступы кнопкой «Проверить
            сейчас», затем включите переключатель в списке.
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
