import { Card, Col, Row, Statistic, Typography, Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  DeliveryListResponseSchema,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { usePwaInstall } from '../../lib/usePwaInstall';

type DeliveryList = z.infer<typeof DeliveryListResponseSchema>;
type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;

export default function DashboardPage() {
  const deliveries = useQuery({
    queryKey: ['deliveries', { status: 'expected' }],
    queryFn: () => api.get<DeliveryList>('/deliveries?status=expected'),
  });
  const inbox = useQuery({
    queryKey: ['source-documents'],
    queryFn: () => api.get<SourceList>('/source-documents?limit=10'),
  });
  const { canInstall, promptInstall } = usePwaInstall();

  return (
    <div>
      <Typography.Title level={3}>Сводка</Typography.Title>
      {canInstall && (
        <Card style={{ marginBottom: 16 }}>
          <Typography.Text strong>Установите приложение на устройство</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Button type="primary" onClick={() => void promptInstall()}>
              Установить
            </Button>
          </div>
        </Card>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title="Ожидаемые приёмки"
              value={deliveries.data?.total ?? 0}
              loading={deliveries.isLoading}
            />
            <Link to="/deliveries?status=expected">Перейти →</Link>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Statistic
              title="Входящих документов / заявок"
              value={inbox.data?.total ?? 0}
              loading={inbox.isLoading}
            />
            <Link to="/inbox">Перейти →</Link>
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card>
            <Typography.Text strong>КПП</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Button type="primary" size="large" block>
                <Link to="/kpp">Открыть КПП</Link>
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
