import { useState } from 'react';
import { Button, Layout, Space, Typography } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { PublicUploadModal } from './PublicUploadModal';

/**
 * Публичная страница /uploads.
 *
 * Открывается поставщиком без авторизации: он выбирает объект и дату поставки
 * и прикладывает документы. Дальше они идут тем же путём, что и загруженные
 * менеджером, — распознавание, раздел «Документы», планшет инспектора.
 *
 * Вне AppShell: ни сайдбара, ни навигации портала здесь быть не должно.
 */
export default function PublicUploadPage() {
  const [open, setOpen] = useState(true);

  return (
    <Layout style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      <Layout.Content
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px 16px',
        }}
      >
        <Space direction="vertical" size="large" style={{ maxWidth: 560, textAlign: 'center' }}>
          <CloudUploadOutlined style={{ fontSize: 56, color: '#1677ff' }} />
          <Typography.Title level={2} style={{ marginBottom: 0 }}>
            Загрузка документов на приёмку
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Приложите документы по поставке — УПД, накладные, счета-фактуры. Укажите объект
            и дату поставки, чтобы документы попали нужному инспектору. Подойдут PDF, фотографии
            и файлы Excel.
          </Typography.Paragraph>
          <Button type="primary" size="large" onClick={() => setOpen(true)}>
            Загрузить документы
          </Button>
        </Space>
      </Layout.Content>

      <PublicUploadModal open={open} onClose={() => setOpen(false)} />
    </Layout>
  );
}
