import { useState } from 'react';
import { Form, Input, Button, Typography, Alert, Space } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { localizeApiError } from '../../services/errorMessages';
import { AuthLayout } from './AuthLayout';

export default function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { email: string; fullName?: string; password: string }) => {
    setError(null);
    setSubmitting(true);
    try {
      // ФИО опционально: пустое поле не отправляем (бэк нормализует в NULL).
      const trimmed = values.fullName?.trim();
      await api.post('/auth/register', {
        email: values.email,
        password: values.password,
        ...(trimmed ? { fullName: trimmed } : {}),
      });
      setSuccess(true);
    } catch (err) {
      setError(localizeApiError(err, 'Ошибка регистрации'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Регистрация" subtitle="Создайте аккаунт для доступа к порталу">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
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
                name="fullName"
                label="ФИО"
                rules={[{ max: 200, message: 'Не более 200 символов' }]}
              >
                <Input
                  placeholder="Иванов Иван Иванович (можно добавить позже)"
                  autoComplete="name"
                />
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
    </AuthLayout>
  );
}
