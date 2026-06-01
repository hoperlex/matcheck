import { Card, Col, Row, Statistic, Typography, Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SourceDocumentListResponseSchema } from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { usePwaInstall } from '../../lib/usePwaInstall';

type SourceList = z.infer<typeof SourceDocumentListResponseSchema>;

export default function DashboardPage() {
  const expectedUpds = useQuery({
    queryKey: ['source-documents', 'unaccepted-upd', 'count'],
    queryFn: () =>
      api.get<SourceList>('/source-documents?kind=upd,transport_waybill&unaccepted=true&limit=1'),
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
              value={expectedUpds.data?.total ?? 0}
              loading={expectedUpds.isLoading}
            />
            <Link to="/kpp">Перейти →</Link>
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
            <Typography.Text strong>Приёмка</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Button type="primary" size="large" block>
                <Link to="/kpp">Открыть приёмку</Link>
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
