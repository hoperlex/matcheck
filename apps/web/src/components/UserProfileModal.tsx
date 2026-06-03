import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Typography,
  message,
} from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import type { UserDto } from '@matcheck/contracts';
import { api, ApiError } from '../services/api';
import { useAuthStore } from '../stores/auth';

/**
 * Личный кабинет: модалка с двумя секциями.
 *
 * 1. Профиль — редактирование ФИО. Email не меняется через ЛК (это логин,
 *    требующий отдельной верификационной процедуры), роль/объект — задача
 *    админа.
 *
 * 2. Смена пароля — три поля (текущий / новый / повтор). Текущий пароль
 *    обязателен: даже если у злоумышленника есть активная сессия, без
 *    знания текущего пароля он не сможет угнать учётку через смену.
 *    После успеха сервер ставит sessionsInvalidatedAt = now → старые
 *    refresh-токены перестают работать, текущая сессия живёт дальше.
 */
export function UserProfileModal({
  open,
  onClose,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [profileForm] = Form.useForm<{ fullName: string }>();
  const [passwordForm] = Form.useForm<{
    currentPassword: string;
    newPassword: string;
    repeatPassword: string;
  }>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (open && user) {
      profileForm.setFieldsValue({ fullName: user.fullName ?? '' });
      passwordForm.resetFields();
    }
  }, [open, user, profileForm, passwordForm]);

  if (!user) return null;

  async function onSaveProfile(values: { fullName: string }) {
    setSavingProfile(true);
    try {
      const updated = await api.patch<UserDto>('/auth/me', {
        fullName: values.fullName?.trim() || null,
      });
      setUser(updated);
      message.success('Профиль сохранён');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setSavingProfile(false);
    }
  }

  async function onChangePassword(values: {
    currentPassword: string;
    newPassword: string;
    repeatPassword: string;
  }) {
    if (values.newPassword !== values.repeatPassword) {
      message.error('Новый пароль и повтор не совпадают');
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      message.success('Пароль изменён');
      passwordForm.resetFields();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : 'Не удалось сменить пароль');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Личный кабинет"
      width={520}
      destroyOnClose
      // Footer ЛК — единственное место выхода из системы (по UX-стандарту:
      // logout — редкое действие, прячем за один клик в профиле, чтобы
      // случайно не нажали в сайдбаре). Popconfirm защищает от случайного
      // клика «Выйти», когда хотели «Закрыть».
      footer={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Popconfirm
            title="Выйти из системы?"
            description="Все несохранённые изменения будут потеряны."
            okText="Выйти"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            onConfirm={onLogout}
            placement="topLeft"
          >
            <Button danger icon={<LogoutOutlined />}>
              Выход
            </Button>
          </Popconfirm>
          <Button onClick={onClose}>Закрыть</Button>
        </Space>
      }
    >
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Профиль
      </Typography.Title>
      <Form
        layout="vertical"
        form={profileForm}
        onFinish={onSaveProfile}
        disabled={savingProfile}
      >
        <Form.Item label="Email">
          <Input value={user.email} disabled />
        </Form.Item>
        <Form.Item
          name="fullName"
          label="ФИО"
          rules={[{ max: 200, message: 'Не более 200 символов' }]}
        >
          <Input placeholder="Иванов Иван Иванович" autoComplete="name" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={savingProfile}>
          Сохранить
        </Button>
      </Form>

      <Divider />

      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Смена пароля
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="После смены пароля все другие сессии будут закрыты. Эта останется активной."
      />
      <Form
        layout="vertical"
        form={passwordForm}
        onFinish={onChangePassword}
        disabled={savingPassword}
      >
        <Form.Item
          name="currentPassword"
          label="Текущий пароль"
          rules={[{ required: true, message: 'Введите текущий пароль' }]}
        >
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="Новый пароль"
          rules={[{ required: true, min: 8, message: 'Минимум 8 символов' }]}
          extra="≥ 8 символов, 3 класса (буквы/цифры/спецсимволы), не из утечек HIBP."
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="repeatPassword"
          label="Повтор нового пароля"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: 'Повторите новый пароль' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || value === getFieldValue('newPassword')) return Promise.resolve();
                return Promise.reject(new Error('Пароли не совпадают'));
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={savingPassword}>
          Сменить пароль
        </Button>
      </Form>
    </Modal>
  );
}
