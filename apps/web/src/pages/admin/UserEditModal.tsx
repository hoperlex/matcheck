import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CustomerCounterparty,
  Site,
  UserAdminPatch,
  UserDto,
  UserRole,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { roleLabel } from '../../shared/constants/roleLabels';

const roles: UserRole[] = ['admin', 'manager', 'inspector_kpp', 'contractor', 'monitor'];

function hasValidInn(inn: string | null | undefined): boolean {
  const digits = (inn ?? '').replace(/[^0-9]/g, '');
  return digits.length > 0 && !/^0+$/.test(digits);
}

/**
 * Редактирование пользователя из таблицы Администрирование → Пользователи.
 * Объединяет:
 *  - правка email / ФИО / роли / объекта / контакта / активности;
 *  - смена пароля (раскрывается опционально);
 *  - удаление пользователя (Popconfirm, hard delete).
 * Inline-редактирование в самой таблице (Switch активности, Select роли)
 * остаётся как было — модалка нужна для остальных операций и для удобства
 * «открыть карточку пользователя».
 */
export function UserEditModal({
  user,
  sites,
  customerCps,
  open,
  onClose,
}: {
  user: UserDto | null;
  sites: Site[];
  customerCps: CustomerCounterparty[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const isSelf = user?.id === currentUserId;

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<UserRole>('manager');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [contractorCustomerId, setContractorCustomerId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [newPwd, setNewPwd] = useState('');

  // Каждое открытие модалки на новой записи — сбрасываем форму на актуальные
  // серверные значения. destroyOnClose у Modal'а тоже подстраховывает, но
  // без явного reset state переживает между open=false/true.
  useEffect(() => {
    if (!user) return;
    setEmail(user.email);
    setFullName(user.fullName ?? '');
    setRole(user.role);
    setSiteId(user.siteId);
    setContractorCustomerId(user.contractorCustomerId);
    setPhone(user.phone ?? '');
    setIsActive(user.isActive);
    setPwdOpen(false);
    setNewPwd('');
  }, [user]);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserAdminPatch }) =>
      api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.status === 409) {
        message.error('Этот email уже занят');
        return;
      }
      message.error(err.message);
    },
  });

  const setPassword = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      api.post(`/admin/users/${id}/password`, { newPassword }),
    onSuccess: () => {
      message.success('Пароль обновлён');
      setPwdOpen(false);
      setNewPwd('');
    },
    onError: (err: Error) => message.error(err.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      message.success('Пользователь удалён');
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose();
    },
    onError: (err: Error) => message.error(err.message),
  });

  if (!user) return null;

  const onSave = () => {
    const body: UserAdminPatch = {
      email: email.trim().toLowerCase(),
      fullName: fullName.trim() ? fullName.trim() : null,
      role,
      // inspector_kpp может иметь siteId; для остальных — бэк сам обнулит.
      siteId: role === 'inspector_kpp' ? siteId : null,
      // contractor привязан к подрядчику; для остальных ролей — null.
      contractorCustomerId: role === 'contractor' ? contractorCustomerId : null,
      phone: phone.trim() ? phone.trim() : null,
      isActive,
    };
    patch.mutate({ id: user.id, body });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={`Редактирование: ${user.email}`}
      width={560}
      destroyOnClose
      footer={[
        <Popconfirm
          key="delete"
          title="Удалить пользователя?"
          description="Действие необратимо. Все ссылки на этого юзера в данных останутся, но залогиниться он не сможет."
          okText="Удалить"
          okButtonProps={{ danger: true, loading: del.isPending }}
          cancelText="Отмена"
          onConfirm={() => del.mutate(user.id)}
          disabled={isSelf}
        >
          <Button danger icon={<DeleteOutlined />} disabled={isSelf}>
            Удалить
          </Button>
        </Popconfirm>,
        <Button key="cancel" onClick={onClose}>
          Отмена
        </Button>,
        <Button key="save" type="primary" loading={patch.isPending} onClick={onSave}>
          Сохранить
        </Button>,
      ]}
    >
      {isSelf && (
        <Alert
          type="info"
          showIcon
          message="Это ваш аккаунт. Удалить себя нельзя (защита от потери доступа)."
          style={{ marginBottom: 12 }}
        />
      )}
      <Form layout="vertical">
        <Form.Item label="Email" required>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            maxLength={254}
          />
        </Form.Item>
        <Form.Item label="ФИО">
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={200}
            placeholder="Иванов Иван Иванович"
          />
        </Form.Item>
        <Form.Item label="Роль">
          <Select<UserRole>
            value={role}
            onChange={(v) => setRole(v)}
            options={roles.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Form.Item>
        {role === 'inspector_kpp' && (
          <Form.Item label="Объект">
            <Select<string>
              value={siteId ?? undefined}
              onChange={(v) => setSiteId(v ?? null)}
              placeholder="Не назначен"
              showSearch
              optionFilterProp="label"
              allowClear
              options={sites.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
            />
          </Form.Item>
        )}
        {role === 'contractor' && (
          <Form.Item
            label="Подрядчик"
            help="Записи без ИНН недоступны — по ИНН строится область видимости."
          >
            <Select<string>
              value={contractorCustomerId ?? undefined}
              onChange={(v) => setContractorCustomerId(v ?? null)}
              placeholder="Не назначен"
              showSearch
              optionFilterProp="label"
              allowClear
              options={customerCps.map((c) => ({
                value: c.id,
                label: `${c.name} · ИНН ${c.inn || '—'}`,
                disabled: !hasValidInn(c.inn),
              }))}
            />
          </Form.Item>
        )}
        <Form.Item label="Контактный телефон">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+7 …"
            maxLength={32}
          />
        </Form.Item>
        <Form.Item label="Активен">
          <Switch checked={isActive} onChange={setIsActive} />
        </Form.Item>
      </Form>

      <Divider style={{ margin: '8px 0 12px' }} />
      {!pwdOpen ? (
        <Button icon={<KeyOutlined />} onClick={() => setPwdOpen(true)}>
          Сменить пароль
        </Button>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Новый пароль (минимум 8 символов). Текущий пароль вводить не нужно — это смена админом.
          </Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input.Password
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder="Новый пароль"
              maxLength={256}
              // Без этого браузерный менеджер паролей подставлял в поле
              // пароль ТЕКУЩЕГО админа (autofill), и при «Применить» чужой
              // пароль уходил целевому юзеру. new-password подавляет
              // автозаполнение сохранённых кредов.
              autoComplete="new-password"
            />
            <Button
              type="primary"
              loading={setPassword.isPending}
              disabled={newPwd.length < 8}
              onClick={() => setPassword.mutate({ id: user.id, newPassword: newPwd })}
            >
              Применить
            </Button>
            <Button
              onClick={() => {
                setPwdOpen(false);
                setNewPwd('');
              }}
            >
              Отмена
            </Button>
          </Space.Compact>
        </Space>
      )}
    </Modal>
  );
}
