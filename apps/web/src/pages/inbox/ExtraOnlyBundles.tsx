import { Alert, Card, Empty, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { apiGetExtraOnlyBundles } from '../../services/api';
import { ExtraFilesBlock } from './ExtraFilesBlock';
import { formatDateRu } from '../../shared/utils/formatRu';

/**
 * Комплекты, из которых не появилось ни одного документа.
 *
 * Так выглядит поставка, где прислали только сертификаты, либо тип ни одного
 * файла определить не удалось. Карточки документа у такой поставки нет —
 * без этого раздела её файлы лежали бы в S3 и в реестре, но открыть их было бы
 * негде.
 */
export default function ExtraOnlyBundles() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['extra-only-bundles'],
    queryFn: () => apiGetExtraOnlyBundles({ limit: 50 }),
  });

  const tabs: PageTabItem[] = [
    { key: 'inbound', label: 'Приёмка', count: null },
    { key: 'outbound', label: 'Отгрузка', count: null },
    { key: 'extra-only', label: 'Без документов', count: query.data?.total ?? null },
  ];

  return (
    <>
      <StickyPageHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Документы
            </Typography.Title>
            <PageTabs
              items={tabs}
              activeKey="extra-only"
              onChange={(k) => {
                if (k === 'extra-only') return;
                navigate(k === 'outbound' ? '/documents?direction=outbound' : '/documents');
              }}
            />
          </div>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Поставки, из которых не создано ни одного документа"
        description="Файлы сохранены и доступны по ссылке. Если в такой поставке всё же был УПД или накладная — загрузите документ ещё раз в зону «УПД и накладные»: система разберёт его заново."
      />

      {query.isLoading && (
        <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
          <Spin size="large" />
        </Space>
      )}
      {query.error && (
        <Alert
          type="error"
          showIcon
          message="Не удалось загрузить список"
          description={(query.error as Error).message}
        />
      )}
      {query.data?.items.length === 0 && <Empty description="Таких комплектов нет" />}

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {query.data?.items.map((b) => (
          <Card
            key={b.bundleId}
            size="small"
            title={
              <Space size={8} wrap>
                <span>{b.siteName ?? 'Объект не указан'}</span>
                <Typography.Text type="secondary">
                  {b.expectedDate ? `поставка ${formatDateRu(b.expectedDate)}` : 'дата не указана'}
                </Typography.Text>
                <Typography.Text type="secondary">
                  загружено {formatDateRu(b.createdAt)}
                </Typography.Text>
              </Space>
            }
          >
            {b.comment && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Комментарий поставщика: {b.comment}
              </Typography.Paragraph>
            )}
            <ExtraFilesBlock files={b.files} compact />
          </Card>
        ))}
      </Space>
    </>
  );
}
