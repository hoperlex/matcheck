import { useState } from 'react';
import { Alert, Button, Form, Input, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';
import type { PasswordResetRequest, PasswordResetRequestResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import { localizeApiError } from '../../services/errorMessages';
import { AuthLayout } from './AuthLayout';

/**
 * «Забыли пароль?» — заявка администратору.
 *
 * Ссылку эта форма не выдаёт и на почту ничего не шлёт: она поднимает у админа
 * в таблице «Пользователи» флаг «Запросил сброс», а ссылку тот выписывает сам и
 * передаёт человеку удобным каналом. Иначе любой, кто знает чужой email, мог бы
 * дёргать форму и обнулять уже отправленную ссылку.
 */
export default function ForgotPasswordPage(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: PasswordResetRequest) => {
    setError(null);
    setSubmitting(true);
    try {
      await api.post<PasswordResetRequestResponse>('/public/password-reset/request', values);
      setSent(true);
    } catch (err) {
      setError(localizeApiError(err, 'Не удалось отправить заявку'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Восстановление доступа" subtitle="Заявка администратору портала">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {sent ? (
          // Формулировка намеренно не подтверждает и не опровергает наличие
          // такого пользователя: иначе форма превращается в проверялку «есть ли
          // у них такой сотрудник».
          <Alert
            type="success"
            showIcon
            message="Заявка отправлена"
            description="Если такой пользователь зарегистрирован, администратор пришлёт вам ссылку для смены пароля."
          />
        ) : (
          <>
            {error ? <Alert type="error" message={error} showIcon /> : null}
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              Укажите email, которым вы входите в портал. Администратор увидит заявку и отправит вам
              ссылку — по ней вы зададите новый пароль сами.
            </Typography.Text>
            <Form layout="vertical" onFinish={onFinish} disabled={submitting} size="large">
              <Form.Item
                name="email"
                label="Email"
                rules={[{ required: true, type: 'email', message: 'Введите корректный email' }]}
              >
                <Input autoComplete="username" inputMode="email" autoFocus />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={submitting} block size="large">
                Отправить заявку
              </Button>
            </Form>
          </>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          <Link to="/login">Вернуться ко входу</Link>
        </Typography.Text>
      </Space>
    </AuthLayout>
  );
}
