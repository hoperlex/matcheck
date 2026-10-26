/**
 * Учётка СБИС (Saby) на странице «ЭДО учётки»: создание, правка ключей и
 * выбор организации после «Проверить доступ».
 *
 * Отдельно от форм Диадока намеренно: у СБИС другие ключи, нет площадки,
 * ящика и опроса, а ветка Диадока — рабочая, и правка «заодно» её не трогает.
 */
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { EdoAccountDto, EdoSbisCheckResult } from '@matcheck/contracts';
import { api } from '../../services/api';
import { sbisCreateBody, sbisPatchBody, type SbisKeysForm } from './edo-sbis';

const KEYS_HINT = (
  <>
    Saby → Настройки → Безопасность → Подключения к Saby → ваше приложение. «ID подключения» и
    «Защищённый ключ» — в карточке приложения; «Сервисный ключ» скачивается значком дискеты у строки
    «с авторизацией по сервисному ключу». Вставляйте только значения, без пробелов и подписей.
  </>
);

/** Что сохранено — длина и отпечаток, без значения. */
function savedHint(
  length: number | null | undefined,
  fingerprint: string | null | undefined,
): string {
  return length
    ? `Сейчас сохранено: ${length} символов, отпечаток ${fingerprint ?? '—'}`
    : 'Сейчас не заполнен';
}

export function SbisCreateForm({ onCreated }: { onCreated: () => void }) {
  const [form] = Form.useForm<SbisKeysForm>();
  const create = useMutation({
    mutationFn: (v: SbisKeysForm) => api.post('/admin/edo-accounts', sbisCreateBody(v)),
    onSuccess: () => {
      message.success('Учётная запись СБИС добавлена. Проверьте доступ и выберите организацию.');
      form.resetFields();
      onCreated();
    },
    onError: (err: Error) => message.error(err.message),
  });
  return (
    <Form<SbisKeysForm> form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Где взять ключи"
        description={KEYS_HINT}
      />
      <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
        <Input placeholder="Например: СБИС СУ-10" />
      </Form.Item>
      <Form.Item
        name="appClientId"
        label="ID подключения"
        rules={[{ required: true, whitespace: true }]}
      >
        <Input autoComplete="off" />
      </Form.Item>
      <Form.Item
        name="appSecret"
        label="Защищённый ключ"
        rules={[{ required: true, whitespace: true }]}
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item
        name="secretKey"
        label="Сервисный ключ"
        rules={[{ required: true, whitespace: true }]}
        extra="Без него вход по ключу не работает: двух первых значений мало."
      >
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
        Сохранить
      </Button>
    </Form>
  );
}

export function SbisEditDrawer({
  account,
  onClose,
  onSaved,
}: {
  account: EdoAccountDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm<SbisKeysForm & { isActive: boolean }>();
  const update = useMutation({
    mutationFn: ({ id, v }: { id: string; v: SbisKeysForm & { isActive: boolean } }) =>
      api.patch(`/admin/edo-accounts/${id}`, sbisPatchBody(v)),
    onSuccess: () => {
      message.success('Сохранено');
      onSaved();
    },
    onError: (err: Error) => message.error(err.message),
  });
  return (
    <Drawer
      open={account !== null}
      onClose={onClose}
      title={`Изменить: ${account?.name ?? ''}`}
      width={520}
      destroyOnClose
      maskClosable={false}
    >
      {account && (
        <Form<SbisKeysForm & { isActive: boolean }>
          form={form}
          layout="vertical"
          initialValues={{ name: account.name, isActive: account.isActive }}
          onFinish={(v) => update.mutate({ id: account.id, v })}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Поля ключей можно оставить пустыми — прежние значения сохранятся"
            description={KEYS_HINT}
          />
          <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="isActive"
            label="Учётка активна"
            valuePropName="checked"
            extra="Выключенная учётка не выгружает УПД. Учётку с выгруженными УПД не удалить — только выключить."
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="appClientId"
            label="ID подключения"
            extra={
              account.sbisAppClientId
                ? `Сейчас сохранено: ${account.sbisAppClientId}`
                : 'Сейчас не заполнен'
            }
          >
            <Input autoComplete="off" placeholder="оставьте пустым, чтобы не менять" />
          </Form.Item>
          <Form.Item
            name="appSecret"
            label="Защищённый ключ"
            extra={savedHint(account.sbisAppSecretLength, account.sbisAppSecretFingerprint)}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder="оставьте пустым, чтобы не менять"
            />
          </Form.Item>
          <Form.Item
            name="secretKey"
            label="Сервисный ключ"
            extra={savedHint(account.sbisSecretKeyLength, account.sbisSecretKeyFingerprint)}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder="оставьте пустым, чтобы не менять"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={update.isPending}>
            Сохранить
          </Button>
        </Form>
      )}
    </Drawer>
  );
}

/**
 * «Проверить доступ» у СБИС: вход по ключам прошёл, вот организации кабинета.
 * Организация выбирается отсюда же — переписывать ИНН/КПП руками незачем, а
 * ошибка в КПП дала бы ленту не той организации.
 */
export function SbisAccessModal({
  account,
  result,
  onClose,
  onChosen,
}: {
  account: EdoAccountDto | null;
  result: EdoSbisCheckResult | null;
  onClose: () => void;
  onChosen: () => void;
}) {
  const choose = useMutation({
    mutationFn: ({ id, ref }: { id: string; ref: string }) =>
      api.patch(`/admin/edo-accounts/${id}`, { boxId: ref }),
    onSuccess: () => {
      message.success('Организация выбрана');
      onChosen();
    },
    onError: (err: Error) => message.error(err.message),
  });
  return (
    <Modal
      open={result !== null}
      onCancel={onClose}
      footer={null}
      title="Доступ к СБИС"
      width={620}
    >
      {result && account && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="success" showIcon message="Вход по ключам прошёл" />
          {!result.complete && (
            <Alert
              type="warning"
              showIcon
              message="Список организаций неполный"
              description="СБИС отдал не все страницы списка. Если нужной организации нет — повторите проверку."
            />
          )}
          <Typography.Text strong>Организации кабинета</Typography.Text>
          {result.organizations.length === 0 && (
            <Typography.Text type="secondary">
              Организаций не найдено: проверьте, к какому кабинету выпущены ключи.
            </Typography.Text>
          )}
          {result.organizations.map((org) => {
            const isCurrent = account.boxId === org.ref;
            return (
              <Card key={org.ref} size="small">
                <Space direction="vertical" size={0} style={{ width: '100%' }}>
                  <Typography.Text>{org.name || '(без названия)'}</Typography.Text>
                  <Typography.Text type="secondary">
                    ИНН {org.inn}
                    {org.kpp ? ` · КПП ${org.kpp}` : ''}
                    {org.branch ? ` · филиал ${org.branch}` : ''}
                  </Typography.Text>
                  <Space size={4} style={{ marginTop: 4 }}>
                    {org.edo ? <Tag color="blue">ЭДО подключён</Tag> : <Tag>ЭДО не подключён</Tag>}
                    {isCurrent && <Tag color="green">выбрана</Tag>}
                  </Space>
                  {!isCurrent && (
                    <Tooltip
                      title={
                        org.edo
                          ? undefined
                          : 'У организации не подключён документооборот — УПД из неё не придут'
                      }
                    >
                      <span>
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0 }}
                          disabled={!org.edo}
                          loading={choose.isPending}
                          onClick={() => choose.mutate({ id: account.id, ref: org.ref })}
                        >
                          Использовать эту организацию
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Space>
              </Card>
            );
          })}
        </Space>
      )}
    </Modal>
  );
}
