import { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../services/api';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/auth/register', values);
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Ошибка регистрации');
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
          <Typography.Title level={3} style={{ margin: 0 }}>
            Регистрация
          </Typography.Title>
          {error && <Alert type="error" message={error} showIcon />}
          {success ? (
            <Space direction="vertical">
              <Alert
                type="success"
                message="Заявка отправлена"
                description="Аккаунт создан, но требует активации администратором."
                showIcon
              />
              <Button block onClick={() => navigate('/login')}>
                К входу
              </Button>
            </Space>
          ) : (
            <Form layout="vertical" onFinish={onFinish} disabled={submitting} size="large">
              <Form.Item
                name="email"
                label="Email"
                rules={[{ required: true, type: 'email', message: 'Корректный email' }]}
              >
                <Input autoComplete="username" inputMode="email" />
              </Form.Item>
              <Form.Item
                name="password"
                label="Пароль"
                rules={[{ required: true, min: 8, message: 'Минимум 8 символов' }]}
                extra="≥ 8 символов, 3 класса (буквы/цифры/спецсимволы), не из утечек HIBP."
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={submitting} block size="large">
                Зарегистрироваться
              </Button>
            </Form>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            Уже есть аккаунт? <Link to="/login">Войти</Link>
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
