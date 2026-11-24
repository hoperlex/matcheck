import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiKeyCreate,
  ApiKeyDto,
  ApiKeyPatch,
  ApiKeySecretResponse,
  ApiKeyStatus,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { formatDateTimeRu } from '../../shared/utils/formatRu';
import { ApiKeySecretModal, type ShownSecret } from './ApiKeySecretModal';

const QUERY_KEY = ['admin', 'api-keys'];

const STATUS: Record<ApiKeyStatus, { label: string; color: string }> = {
  active: { label: 'Активен', color: 'green' },
  expired: { label: 'Истёк', color: 'orange' },
  revoked: { label: 'Отозван', color: 'default' },
};

const ACK_LABEL =
  'Разрешить подтверждение загрузки (POST /deliveries/ack) — единственный метод API, который меняет данные в портале';

type FormValues = {
  name: string;
  description?: string;
  allowAck: boolean;
  expiresAt?: Dayjs | null;
};

/**
 * «Администрирование → API-доступ»: машинные ключи внешних систем (1С).
 *
 * Только администратор: страница в NEVER_GRANTABLE, матрица ролей её никому не
 * выдаёт.
 *
 * Секрет приходит только в ответе на создание и «Новый секрет». Он НЕ попадает в
 * кэш запросов: функция мутации отдаёт его прямо в состояние окна, а наружу
 * возвращает ключ без секрета. Если ответ пришёл, когда страницу уже закрыли,
 * секрет отбрасывается — его никто не увидит, и выход один: «Новый секрет».
 */
export default function AdminApiAccessPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ApiKeyDto | null>(null);
  const [shown, setShown] = useState<ShownSecret | null>(null);
  const [createForm] = Form.useForm<FormValues>();
  const [editForm] = Form.useForm<FormValues>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const invalidate = () => void qc.invalidateQueries({ queryKey: QUERY_KEY });
  const showSecret = (title: string, res: ApiKeySecretResponse) => {
    // Ушли со страницы до ответа — секрет не сохраняем нигде.
    if (!mounted.current) return;
    setShown({ title, clientId: res.key.clientId, clientSecret: res.clientSecret });
  };

  const list = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<ApiKeyDto[]>('/admin/api-keys'),
  });

  const create = useMutation({
    gcTime: 0,
    mutationFn: async (body: ApiKeyCreate): Promise<ApiKeyDto> => {
      const res = await api.post<ApiKeySecretResponse>('/admin/api-keys', body);
      showSecret(`Ключ «${res.key.name}» создан`, res);
      return res.key;
    },
    onSuccess: () => {
      setCreating(false);
      createForm.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const rotate = useMutation({
    gcTime: 0,
    mutationFn: async (key: ApiKeyDto): Promise<ApiKeyDto> => {
      const res = await api.post<ApiKeySecretResponse>(`/admin/api-keys/${key.id}/rotate-secret`, {
        expectedGeneration: key.secretGeneration,
      });
      showSecret(`Новый секрет ключа «${res.key.name}»`, res);
      return res.key;
    },
    onSuccess: invalidate,
    onError: (err: Error) => {
      message.error(err.message);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: (v: { id: string; body: ApiKeyPatch }) => api.patch<ApiKeyDto>(`/admin/api-keys/${v.id}`, v.body),
    onSuccess: () => {
      message.success('Сохранено');
      setEditing(null);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post<ApiKeyDto>(`/admin/api-keys/${id}/revoke`),
    onSuccess: () => {
      message.success('Ключ отозван');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const openEdit = (key: ApiKeyDto) => {
    setEditing(key);
    editForm.setFieldsValue({
      name: key.name,
      description: key.description ?? '',
      allowAck: key.allowAck,
      expiresAt: key.expiresAt ? dayjs(key.expiresAt) : null,
    });
  };

  const toIso = (d: Dayjs | null | undefined) => (d ? d.toISOString() : null);

  const actions = (k: ApiKeyDto, size?: 'small') => {
    if (k.status === 'revoked') return <Typography.Text type="secondary">—</Typography.Text>;
    return (
      <Space size={8} wrap={size === 'small'}>
        <Button size={size} onClick={() => openEdit(k)}>
          Доступы
        </Button>
        <Popconfirm
          title={`Выпустить новый секрет для «${k.name}»?`}
          description="Старый секрет и все выданные по нему токены перестанут работать сразу. 1С не сможет обращаться к порталу, пока в неё не внесут новый секрет."
          okText="Выпустить"
          cancelText="Отмена"
          onConfirm={() => rotate.mutate(k)}
        >
          <Button size={size} loading={rotate.isPending && rotate.variables?.id === k.id}>
            Новый секрет
          </Button>
        </Popconfirm>
        <Popconfirm
          title={`Отозвать ключ «${k.name}»?`}
          description="Ключ перестанет работать сразу. Отменить нельзя."
          okText="Отозвать"
          cancelText="Отмена"
          okButtonProps={{ danger: true }}
          onConfirm={() => revoke.mutate(k.id)}
        >
          <Button size={size} danger loading={revoke.isPending && revoke.variables === k.id}>
            Отозвать
          </Button>
        </Popconfirm>
      </Space>
    );
  };

  const statusTag = (k: ApiKeyDto) => <Tag color={STATUS[k.status].color}>{STATUS[k.status].label}</Tag>;
  const scopeTags = (k: ApiKeyDto) => (
    <Space size={4} wrap>
      <Tag>Чтение</Tag>
      {k.allowAck && <Tag color="blue">Подтверждение загрузки</Tag>}
    </Space>
  );

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            API-ключи
          </Typography.Title>
          <Button type="primary" onClick={() => setCreating(true)}>
            Новый ключ
          </Button>
        </Space>
      }
    >
      <ResponsiveTable<ApiKeyDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        autoColumnTools={{ total: list.data?.length ?? 0 }}
        columns={[
          {
            title: 'Название',
            key: 'name',
            width: 240,
            render: (_: unknown, k: ApiKeyDto) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{k.name}</Typography.Text>
                {k.description && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {k.description}
                  </Typography.Text>
                )}
              </Space>
            ),
            tools: { text: (k) => k.name },
          },
          {
            title: 'client_id',
            key: 'clientId',
            width: 180,
            render: (_: unknown, k: ApiKeyDto) => (
              <Typography.Text code copyable={{ text: k.clientId }}>
                {k.clientId}
              </Typography.Text>
            ),
            tools: { text: (k) => k.clientId },
          },
          {
            title: 'Права',
            key: 'scopes',
            width: 200,
            render: (_: unknown, k: ApiKeyDto) => scopeTags(k),
            tools: { text: (k) => (k.allowAck ? 'Чтение, подтверждение' : 'Чтение') },
          },
          {
            title: 'Создан',
            key: 'createdAt',
            width: 150,
            render: (_: unknown, k: ApiKeyDto) => (
              <Space direction="vertical" size={0}>
                <span>{formatDateTimeRu(k.createdAt)}</span>
                {k.createdByName && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {k.createdByName}
                  </Typography.Text>
                )}
              </Space>
            ),
            tools: { text: (k) => formatDateTimeRu(k.createdAt) },
          },
          {
            title: 'Истекает',
            key: 'expiresAt',
            width: 140,
            render: (_: unknown, k: ApiKeyDto) => (k.expiresAt ? formatDateTimeRu(k.expiresAt) : '—'),
            tools: { text: (k) => (k.expiresAt ? formatDateTimeRu(k.expiresAt) : '—') },
          },
          {
            title: 'Последний запрос',
            key: 'lastUsedAt',
            width: 160,
            render: (_: unknown, k: ApiKeyDto) =>
              k.lastUsedAt ? (
                <Tooltip title={k.lastTokenIp ? `Адрес: ${k.lastTokenIp}` : undefined}>
                  <span>{formatDateTimeRu(k.lastUsedAt)}</span>
                </Tooltip>
              ) : (
                '—'
              ),
            tools: { text: (k) => (k.lastUsedAt ? formatDateTimeRu(k.lastUsedAt) : '—') },
          },
          {
            title: 'Статус',
            key: 'status',
            width: 110,
            render: (_: unknown, k: ApiKeyDto) => statusTag(k),
            tools: { text: (k) => STATUS[k.status].label },
          },
          {
            title: 'Действия',
            key: 'actions',
            width: 330,
            render: (_: unknown, k: ApiKeyDto) => actions(k),
          },
        ]}
        cardRender={(k) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space size={8} wrap>
                <Typography.Text strong>{k.name}</Typography.Text>
                {statusTag(k)}
              </Space>
              <Typography.Text code>{k.clientId}</Typography.Text>
              {scopeTags(k)}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Последний запрос: {k.lastUsedAt ? formatDateTimeRu(k.lastUsedAt) : '—'}
              </Typography.Text>
              {actions(k, 'small')}
            </Space>
          </Card>
        )}
      />

      <Modal
        open={creating}
        title="Новый API-ключ"
        okText="Создать ключ"
        cancelText="Отмена"
        onOk={() => createForm.submit()}
        onCancel={() => setCreating(false)}
        confirmLoading={create.isPending}
        // Пока ключ создаётся, окно не закрыть: секрет придёт сюда.
        closable={!create.isPending}
        keyboard={!create.isPending}
        maskClosable={false}
        cancelButtonProps={{ disabled: create.isPending }}
        destroyOnHidden
      >
        <Form<FormValues>
          form={createForm}
          layout="vertical"
          initialValues={{ allowAck: false }}
          onFinish={(v) =>
            create.mutate({
              name: v.name,
              description: v.description || undefined,
              allowAck: v.allowAck,
              expiresAt: toIso(v.expiresAt),
            })
          }
        >
          <KeyFormFields />
        </Form>
      </Modal>

      <Modal
        open={editing !== null}
        title={editing ? `Доступы: ${editing.name}` : ''}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={() => editForm.submit()}
        onCancel={() => setEditing(null)}
        confirmLoading={update.isPending}
        maskClosable={false}
        destroyOnHidden
      >
        {editing && (
          <Form<FormValues>
            form={editForm}
            layout="vertical"
            onFinish={(v) =>
              update.mutate({
                id: editing.id,
                body: {
                  name: v.name,
                  description: v.description ?? '',
                  allowAck: v.allowAck,
                  expiresAt: toIso(v.expiresAt),
                },
              })
            }
          >
            <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size={4}>
              <Typography.Text type="secondary">
                client_id: <Typography.Text code copyable>{editing.clientId}</Typography.Text>
              </Typography.Text>
              {editing.allowedCidrs && editing.allowedCidrs.length > 0 && (
                <Typography.Text type="secondary">
                  Разрешённые адреса: {editing.allowedCidrs.join(', ')} (меняются на сервере командой
                  set-cidr)
                </Typography.Text>
              )}
            </Space>
            <KeyFormFields />
            {!editing.allowAck && (
              <Alert
                type="info"
                showIcon
                message="Разрешение подтверждения начнёт действовать, когда 1С получит новый токен — в течение 10 минут. Снятие действует сразу."
              />
            )}
          </Form>
        )}
      </Modal>

      <ApiKeySecretModal secret={shown} onClose={() => setShown(null)} />
    </StickyPageHeader>
  );
}

function KeyFormFields() {
  return (
    <>
      <Form.Item
        name="name"
        label="Название"
        rules={[{ required: true, whitespace: true, message: 'Укажите название' }]}
      >
        <Input placeholder="Например, 1С бухгалтерия" maxLength={100} />
      </Form.Item>
      <Form.Item name="description" label="Описание">
        <Input.TextArea placeholder="Кому выдан и зачем" rows={3} maxLength={1000} />
      </Form.Item>
      <Form.Item name="allowAck" label="Подтверждение загрузки" valuePropName="checked">
        <Checkbox>{ACK_LABEL}</Checkbox>
      </Form.Item>
      <Form.Item name="expiresAt" label="Действует до (необязательно)">
        <DatePicker showTime format="DD.MM.YYYY HH:mm" style={{ width: '100%' }} placeholder="Бессрочно" />
      </Form.Item>
    </>
  );
}
