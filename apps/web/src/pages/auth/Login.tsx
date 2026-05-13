import { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import type { LoginResponse } from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/auth';

type LocationState = { from?: { pathname: string } };

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<LoginResponse>('/auth/login', values);
      setAuth(res.accessToken, res.user);
      const from = (location.state as LocationState | null)?.from?.pathname ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Ошибка входа');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: '#f5f5f5',
        padding: 16,
      }}
    >
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Вход в matcheck
            </Typography.Title>
            <Typography.Text type="secondary">Приёмка материалов</Typography.Text>
          </div>
          {error && <Alert type="error" message={error} showIcon />}
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
            Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
