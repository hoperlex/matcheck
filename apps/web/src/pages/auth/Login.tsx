import { useState } from 'react';
import { Form, Input, Button, Typography, Alert, Space } from 'antd';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import type { LoginResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { syncPermissions } from '../../services/permissionsSync';
import { localizeApiError } from '../../services/errorMessages';
import { useAuthStore } from '../../stores/auth';
import { AuthLayout } from './AuthLayout';

type LocationState = { from?: { pathname: string } };

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<LoginResponse>('/auth/login', values);
      setAuth(res.accessToken, res.user);
      // Права — до перехода на страницу: иначе первый экран после входа
      // рисуется по дефолтам роли и тут же перестраивается. Загрузку уже
      // начала подписка permissionsScheduler на смену пользователя, здесь мы
      // лишь дожидаемся её (single-flight, один сетевой запрос). Отказ не
      // блокирует вход — работаем по дефолтам, сервер всё равно проверяет сам.
      await syncPermissions(res.user);
      const from = (location.state as LocationState | null)?.from?.pathname ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(localizeApiError(err, 'Ошибка входа'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Вход в систему" subtitle="Введите данные для доступа к порталу">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {error ? (
          <Alert type="error" message={error} showIcon />
        ) : sessionExpired ? (
          <Alert type="warning" message="Сессия истекла — войдите снова" showIcon />
        ) : null}
        <Form layout="vertical" onFinish={onFinish} disabled={submitting} size="large">
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
          >
            <Input autoComplete="username" inputMode="email" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[{ required: true, message: 'Введите пароль' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            Войти
          </Button>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          <Link to="/forgot-password">Забыли пароль?</Link>
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </Typography.Text>
      </Space>
    </AuthLayout>
  );
}
