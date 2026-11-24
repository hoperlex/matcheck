import { useState } from 'react';
import { Alert, Button, Input, Modal, Space, Typography, message } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

export type ShownSecret = {
  title: string;
  clientId: string;
  clientSecret: string;
};

/** Адрес, по которому 1С получает токен (docs/ONEC_API.md). */
const PORTAL_URL = 'https://mat.su10.ru';

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      message.success(`${label}: скопировано`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error('Не удалось скопировать');
    }
  };
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Space.Compact style={{ width: '100%' }}>
        <Input value={value} readOnly aria-label={label} style={{ fontFamily: 'monospace' }} />
        <Button type={copied ? 'default' : 'primary'} icon={<CopyOutlined />} onClick={copy}>
          {copied ? 'Скопировано' : 'Копировать'}
        </Button>
      </Space.Compact>
    </div>
  );
}

/**
 * Секрет ключа — один раз. В портале хранится только его отпечаток, поэтому
 * закрыл окно — секрет нигде больше не прочитать; потерянный секрет заменяется
 * кнопкой «Новый секрет».
 *
 * Секрет живёт только в состоянии вызывающего (props): в кэш запросов он не
 * попадает, при закрытии вызывающий его стирает.
 */
export function ApiKeySecretModal({
  secret,
  onClose,
}: {
  secret: ShownSecret | null;
  onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      open={secret !== null}
      title={secret?.title}
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          Я сохранил секрет
        </Button>
      }
      maskClosable={false}
      destroyOnHidden
    >
      {secret && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="warning"
            showIcon
            message="Секрет показывается один раз"
            description="Сохраните его в защищённом хранилище 1С. После закрытия окна секрет больше нигде не прочитать — только выпустить новый."
          />
          <CopyField label="client_id" value={secret.clientId} />
          <CopyField label="Секрет" value={secret.clientSecret} />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            Адрес портала: {PORTAL_URL}. Токен 1С получает запросом POST
            /api/v1/public/integration/token с этими client_id и секретом.
          </Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
