import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResponsiblePerson,
  ResponsiblePersonImportResponse,
  ResponsiblePersonUpsert,
} from '@matcheck/contracts';
import { api, apiUploadFile, ApiError } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';

type List = { items: ResponsiblePerson[]; total: number };

export default function ResponsiblePersonsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [form] = Form.useForm<ResponsiblePersonUpsert>();

  const list = useQuery({
    queryKey: ['responsible-persons', search],
    queryFn: () =>
      api.get<List>(`/responsible-persons${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });

  const create = useMutation({
    mutationFn: (body: ResponsiblePersonUpsert) => api.post('/responsible-persons', body),
    onSuccess: () => {
      message.success('МОЛ создан');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['responsible-persons'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            МОЛ (материально-ответственные лица)
          </Typography.Title>
          <Space>
            <Input.Search placeholder="ФИО" allowClear onSearch={setSearch} />
            <Button onClick={() => setImportOpen(true)}>Импорт из Excel</Button>
            <Button type="primary" onClick={() => setOpen(true)}>
              Добавить
            </Button>
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<ResponsiblePerson>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          {
            title: 'ФИО',
            dataIndex: 'fullName',
            sorter: stringSorter<ResponsiblePerson>((r) => r.fullName),
          },
          {
            title: 'Должность',
            dataIndex: 'position',
            sorter: stringSorter<ResponsiblePerson>((r) => r.position),
          },
          {
            title: 'Телефон',
            dataIndex: 'phone',
            sorter: stringSorter<ResponsiblePerson>((r) => r.phone),
          },
          {
            title: 'Статус',
            key: 'status',
            sorter: (a: ResponsiblePerson, b: ResponsiblePerson) =>
              Number(b.isActive) - Number(a.isActive),
            render: (_: unknown, r: ResponsiblePerson) =>
              r.isActive ? (
                <Tag color="green">Активный</Tag>
              ) : (
                <Tag color="default">В архиве</Tag>
              ),
          },
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small">
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.fullName}</Typography.Text>
              {r.position && (
                <Typography.Text type="secondary">{r.position}</Typography.Text>
              )}
              {r.phone && <Typography.Text type="secondary">{r.phone}</Typography.Text>}
              {!r.isActive && <Tag color="default">В архиве</Tag>}
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новый МОЛ"
        width={420}
        destroyOnClose
      >
        <Form<ResponsiblePersonUpsert>
          form={form}
          layout="vertical"
          initialValues={{ isActive: true }}
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item name="fullName" label="ФИО" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="position" label="Должность">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Телефон">
            <Input inputMode="tel" />
          </Form.Item>
          <Form.Item name="isActive" label="Активный" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          void qc.invalidateQueries({ queryKey: ['responsible-persons'] });
        }}
      />
    </StickyPageHeader>
  );
}

function ImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ResponsiblePersonImportResponse | null>(null);

  function close() {
    if (uploading) return;
    setResult(null);
    onClose();
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const res = await apiUploadFile<ResponsiblePersonImportResponse>(
        '/responsible-persons/import',
        file,
      );
      setResult(res);
      onImported();
      if (res.created > 0) {
        message.success(`Импортировано: ${res.created}`);
      } else if (res.errors.length === 0 && res.skippedDuplicates > 0) {
        message.info('Все строки уже есть в справочнике');
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message || `HTTP ${err.status}`
          : err instanceof Error
            ? err.message
            : String(err);
      message.error(msg);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Импорт МОЛ из Excel"
      onCancel={close}
      maskClosable={!uploading}
      closable={!uploading}
      footer={
        <Button onClick={close} disabled={uploading}>
          Закрыть
        </Button>
      }
      width={640}
    >
      {!result && (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Колонки: ФИО, Должность, Телефон."
            description="Заголовки — в первой строке. Обязательное поле — только ФИО. Дубликаты по ФИО пропускаются."
          />
          <Upload.Dragger
            accept=".xlsx,.xls"
            multiple={false}
            showUploadList={false}
            disabled={uploading}
            beforeUpload={(file) => {
              void upload(file as unknown as File);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">
              {uploading ? 'Загрузка…' : 'Перетащите .xlsx или нажмите для выбора'}
            </p>
            <p className="ant-upload-hint">Лимит — 10 МБ.</p>
          </Upload.Dragger>
        </>
      )}
      {result && (
        <>
          <Alert
            type={result.errors.length === 0 ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`Создано: ${result.created} · Пропущено дубликатов: ${result.skippedDuplicates} · Ошибок: ${result.errors.length}`}
          />
          {result.errors.length > 0 && (
            <List
              size="small"
              bordered
              header={<Typography.Text strong>Строки с ошибками</Typography.Text>}
              dataSource={result.errors}
              renderItem={(e) => (
                <List.Item>
                  <Typography.Text>
                    Строка {e.row}: <Typography.Text type="danger">{e.reason}</Typography.Text>
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}
        </>
      )}
    </Modal>
  );
}
