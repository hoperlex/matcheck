import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EdoAccountCreate,
  EdoAccountDto,
  EdoCheckResult,
  EdoJobQueued,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { usePermissions } from '../../shared/hooks/usePermissions';

/**
 * Возраст refresh-токена: он живёт 30 дней, и счётчик продлевается только при
 * использовании. Учётка с выключенным опросом умирает молча, поэтому возраст
 * показывается рядом с именем, а не прячется в подробностях.
 */
const TOKEN_WARN_DAYS = 25;

function TokenAge({ days }: { days: number | null }) {
  if (days === null) return <Typography.Text type="secondary">—</Typography.Text>;
  if (days >= TOKEN_WARN_DAYS) {
    return (
      <Tooltip title="Refresh-токен действует 30 дней с момента последнего использования. Включите опрос или выпустите новый токен в Кабинете интегратора.">
        <Tag color="red">{days} дн.</Tag>
      </Tooltip>
    );
  }
  return <Tag color="green">{days} дн.</Tag>;
}

export default function AdminEdoAccountsPage() {
  const qc = useQueryClient();
  // Страницу можно выдать на просмотр отдельно от управления, поэтому контролы
  // спрашивают действие, а не факт открытия страницы.
  const { can } = usePermissions();
  const canCreate = can('admin.edo_accounts', 'create');
  // Действия `edit` у страницы нет вовсе, поэтому обслуживание гейтим по правам
  // управления учётками: у кого есть заведение или удаление, у того есть и
  // обслуживание. Роль с одним лишь просмотром кнопок не увидит — на сервере
  // эти маршруты ей закрыты (matrixOnly: deny в route-map).
  const canManage = canCreate || can('admin.edo_accounts', 'delete');
  const [open, setOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<EdoCheckResult | null>(null);
  const [form] = Form.useForm<EdoAccountCreate>();

  const list = useQuery({
    queryKey: ['admin', 'edo-accounts'],
    queryFn: () => api.get<EdoAccountDto[]>('/admin/edo-accounts'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'edo-accounts'] });

  const create = useMutation({
    mutationFn: (body: EdoAccountCreate) => api.post('/admin/edo-accounts', body),
    onSuccess: () => {
      message.success('Учётная запись добавлена. Проверьте доступ, прежде чем включать опрос.');
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const togglePoll = useMutation({
    mutationFn: ({ id, pollEnabled }: { id: string; pollEnabled: boolean }) =>
      api.patch(`/admin/edo-accounts/${id}`, { pollEnabled }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => message.error(err.message),
  });

  const check = useMutation({
    mutationFn: (id: string) => api.post<EdoCheckResult>(`/admin/edo-accounts/${id}/check`),
    onSuccess: (r) => {
      setCheckResult(r);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Раньше кнопка держала браузер до десяти минут: импорт шёл прямо в процессе
  // API. Теперь это работа в очереди — ответ сразу, ход виден по состоянию
  // учётной записи.
  const sync = useMutation({
    mutationFn: (id: string) => api.post<EdoJobQueued>(`/admin/edo-accounts/${id}/sync`),
    onSuccess: () => message.success('Синхронизация запущена'),
    onError: (err: Error) => message.error(err.message),
  });

  const inventory = useMutation({
    mutationFn: (id: string) =>
      api.post<EdoJobQueued>(`/admin/edo-accounts/${id}/inventory`, {}),
    onSuccess: () =>
      message.success('Разведка запущена: ничего не импортируется, отчёт появится в карточке'),
    onError: (err: Error) => message.error(err.message),
  });

  const actions = (r: EdoAccountDto) => (
    <Space wrap size="small">
      <Button size="small" onClick={() => check.mutate(r.id)} loading={check.isPending}>
        Проверить доступ
      </Button>
      <Tooltip title="Пройти по ленте и показать, какие документы лежат в ящике. Ничего не импортирует.">
        <Button
          size="small"
          onClick={() => inventory.mutate(r.id)}
          loading={inventory.isPending}
          disabled={!r.boxId}
        >
          Осмотреть ящик
        </Button>
      </Tooltip>
      <Button size="small" onClick={() => sync.mutate(r.id)} loading={sync.isPending}>
        Синхронизировать
      </Button>
    </Space>
  );

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            ЭДО учётки (Диадок)
          </Typography.Title>
          {canCreate && (
            <Button type="primary" onClick={() => setOpen(true)}>
              Добавить
            </Button>
          )}
        </Space>
      }
    >
      <ResponsiveTable<EdoAccountDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Имя', dataIndex: 'name' },
          {
            title: 'Площадка',
            dataIndex: 'environment',
            render: (e: EdoAccountDto['environment']) => (
              <Tag color={e === 'production' ? 'blue' : 'orange'}>
                {e === 'production' ? 'боевая' : 'тестовая'}
              </Tag>
            ),
          },
          {
            title: 'Ящик',
            dataIndex: 'boxId',
            render: (b: string | null) =>
              b ? (
                <Typography.Text code>{b.slice(0, 8)}…</Typography.Text>
              ) : (
                <Tag>не выбран</Tag>
              ),
          },
          {
            title: 'Опрос',
            key: 'poll',
            render: (_: unknown, r: EdoAccountDto) => (
              <Switch
                size="small"
                checked={r.pollEnabled}
                disabled={!canManage || togglePoll.isPending}
                onChange={(v) => togglePoll.mutate({ id: r.id, pollEnabled: v })}
              />
            ),
          },
          {
            title: 'Токен',
            key: 'token',
            render: (_: unknown, r: EdoAccountDto) => <TokenAge days={r.refreshTokenAgeDays} />,
          },
          {
            title: 'Состояние',
            key: 'state',
            render: (_: unknown, r: EdoAccountDto) =>
              r.lastError ? (
                <Tooltip title={r.lastError}>
                  <Tag color="red">ошибка</Tag>
                </Tooltip>
              ) : r.lastOkAt ? (
                <Tag color="green">в порядке</Tag>
              ) : (
                <Tag>не проверялась</Tag>
              ),
          },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: EdoAccountDto) =>
              canManage ? actions(r) : <Typography.Text type="secondary">—</Typography.Text>,
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{r.name}</Typography.Text>
                <Tag color={r.environment === 'production' ? 'blue' : 'orange'}>
                  {r.environment === 'production' ? 'боевая' : 'тестовая'}
                </Tag>
                <TokenAge days={r.refreshTokenAgeDays} />
              </Space>
              {r.lastError && <Typography.Text type="danger">{r.lastError}</Typography.Text>}
              {canManage && actions(r)}
            </Space>
          </Card>
        )}
      />

      <Modal
        open={checkResult !== null}
        onCancel={() => setCheckResult(null)}
        footer={null}
        title="Доступ к Диадоку"
        width={620}
      >
        {checkResult && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {!checkResult.employee.hasRequiredAccess && (
              <Alert
                type="warning"
                showIcon
                message="Прав недостаточно"
                description={
                  checkResult.employee.isBlocked
                    ? 'Учётная запись заблокирована в Диадоке.'
                    : 'Интеграции нужен доступ ко всем документам ящика (AllDocuments). При ограниченном доступе часть документов не удастся прочитать.'
                }
              />
            )}
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Уровень доступа">
                {checkResult.employee.documentAccessLevel ?? '—'}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Text strong>Доступные ящики</Typography.Text>
            {checkResult.boxes.map((b) => (
              <Card key={b.boxId} size="small">
                <Space direction="vertical" size={0}>
                  <Typography.Text>{b.title || '(без названия)'}</Typography.Text>
                  <Typography.Text type="secondary">
                    ИНН {b.inn ?? '—'} · КПП {b.kpp ?? '—'}
                  </Typography.Text>
                  <Typography.Text copyable code>
                    {b.boxId}
                  </Typography.Text>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Modal>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новая учётная запись ЭДО"
        width={520}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<EdoAccountCreate>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{
            provider: 'diadoc',
            isActive: true,
            environment: 'production',
            credentials: { authMode: 'oidc_refresh' },
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Где взять доступы"
            description={
              <>
                client_id выдаёт менеджер Диадока, ключ приложения и первичный refresh-токен
                выпускаются в Кабинете интегратора. Используйте сервисную учётную запись, а не
                личную: при увольнении сотрудника интеграция не должна падать.
              </>
            }
          />
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Например: Диадок СУ-10" />
          </Form.Item>
          <Form.Item
            name="environment"
            label="Площадка"
            rules={[{ required: true }]}
            extra="Ящик, выданный на одной площадке, на другой не работает."
          >
            <Select
              options={[
                { value: 'production', label: 'Боевая' },
                { value: 'staging', label: 'Тестовая' },
              ]}
            />
          </Form.Item>
          <Form.Item name={['credentials', 'authMode']} hidden initialValue="oidc_refresh">
            <Input />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientId']}
            label="client_id"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientSecret']}
            label="Ключ приложения (client_secret)"
            rules={[{ required: true }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name={['credentials', 'refreshToken']}
            label="Первичный refresh-токен"
            rules={[{ required: true }]}
            extra="Действует 30 дней с момента последнего использования."
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="boxId"
            label="Box ID"
            extra="Можно не заполнять: подставится после «Проверить доступ»."
          >
            <Input />
          </Form.Item>
          <Form.Item name="orgInn" label="ИНН нашей организации">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
