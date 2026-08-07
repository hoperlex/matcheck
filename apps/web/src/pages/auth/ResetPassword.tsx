import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Space, Spin, Typography } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import type {
  PasswordResetConsumeResponse,
  PasswordResetInspectResponse,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { localizeApiError } from '../../services/errorMessages';
import { AuthLayout } from './AuthLayout';

/**
 * Страница смены пароля по ссылке от администратора.
 *
 * Токен приходит во ФРАГМЕНТЕ (/reset-password#<token>), а не в пути. Фрагмент
 * не отправляется на сервер вообще: он не попадает ни в логи прокси, ни в
 * заголовок Referer, ни в телеметрию. Читаем его один раз в память и сразу
 * вычищаем адресную строку, чтобы токен не остался в истории браузера и не
 * ушёл со скриншотом.
 */
export default function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const tokenRef = useRef<string>('');
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const token = window.location.hash.replace(/^#/, '');
    tokenRef.current = token;
    // Чистим адресную строку до первого сетевого запроса — если вкладку закроют
    // или снимут экран, токена в URL уже не будет.
    if (token) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!token) {
      setLinkError('Ссылка неполная — откройте её целиком из сообщения администратора.');
      setChecking(false);
      return;
    }

    void (async () => {
      try {
        const res = await api.post<PasswordResetInspectResponse>(
          '/public/password-reset/inspect',
          { token },
        );
        setEmail(res.email);
      } catch (err) {
        // Проверяем ДО ввода пароля: обидно придумать пароль и только потом
        // узнать, что ссылка протухла.
        setLinkError(
          localizeApiError(
            err,
            'Ссылка недействительна: она уже использована, отозвана или истекла. Запросите новую.',
          ),
        );
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const onFinish = async (values: { newPassword: string }) => {
    setError(null);
    setSubmitting(true);
    try {
      await api.post<PasswordResetConsumeResponse>('/public/password-reset/consume', {
        token: tokenRef.current,
        newPassword: values.newPassword,
      });
      // Автоматического входа нет намеренно: пароль могли менять не на своём
      // устройстве, да и человеку полезно сразу проверить, что он работает.
      navigate('/login', { replace: true });
    } catch (err) {
      setError(localizeApiError(err, 'Не удалось сменить пароль'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title="Новый пароль" subtitle={email ? `Для ${email}` : undefined}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {checking ? (
          <Spin />
        ) : linkError ? (
          <>
            <Alert type="error" message={linkError} showIcon />
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              <Link to="/forgot-password">Запросить новую ссылку</Link>
            </Typography.Text>
          </>
        ) : (
          <>
            {error ? <Alert type="error" message={error} showIcon /> : null}
            <Form layout="vertical" onFinish={onFinish} disabled={submitting} size="large">
              <Form.Item
                name="newPassword"
                label="Новый пароль"
                rules={[
                  { required: true, message: 'Введите пароль' },
                  { min: 8, message: 'Минимум 8 символов' },
                ]}
              >
                <Input.Password autoComplete="new-password" autoFocus />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="Повторите пароль"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: 'Повторите пароль' },
                  ({ getFieldValue }) => ({
                    validator: (_, value) =>
                      !value || getFieldValue('newPassword') === value
                        ? Promise.resolve()
                        : Promise.reject(new Error('Пароли не совпадают')),
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={submitting} block size="large">
                Сохранить пароль
              </Button>
            </Form>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              После смены пароля все открытые сессии на других устройствах завершатся.
            </Typography.Text>
          </>
        )}
      </Space>
    </AuthLayout>
  );
}
