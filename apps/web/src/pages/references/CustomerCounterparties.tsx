import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Drawer,
  Form,
  Grid,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkDeleteResponse,
  CustomerCounterparty,
  CustomerCounterpartySite,
  CustomerCounterpartyUpsert,
  Site,
} from '@matcheck/contracts';
import { api, ApiError } from '../../services/api';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { stringSorter } from '../../shared/ui/tableSorters';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { BulkActionInline } from '../../shared/ui/BulkActionInline';
import { DebouncedSearch } from '../../shared/ui/DebouncedSearch';
import { useUrlParam } from '../../shared/hooks/useUrlParam';
import {
  ContractorSitesFormList,
  ContractorSitesText,
  ContractorSiteTags,
  contractorSiteLabel,
  contractorSitesChanged,
  siteSelectOptions,
} from './contractorSites';

type List = { items: CustomerCounterparty[]; total: number };

export default function CustomerCounterpartiesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // null — режим создания, иначе редактируется конкретная запись.
  const [editing, setEditing] = useState<CustomerCounterparty | null>(null);
  // Поиск — в адресе: переживает переключение вкладок и уход из раздела.
  const [search, setSearch] = useUrlParam('q');
  const [form] = Form.useForm<CustomerCounterpartyUpsert>();

  // withSites=1 — связи «объект → вид» нужны только этой странице; остальные
  // экраны грузят список без них (суммы 1С не уходят инспекторам).
  const list = useQuery({
    queryKey: ['customer-counterparties', 'with-sites', search],
    queryFn: () =>
      api.get<List>(
        `/customer-counterparties?limit=5000&withSites=1${search ? `&q=${encodeURIComponent(search)}` : ''}`,
      ),
  });

  const sitesList = useQuery({
    queryKey: ['sites', { activeOnly: false, limit: 200 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?limit=200'),
    enabled: open,
  });
  const siteOptions = useMemo(
    () => siteSelectOptions(sitesList.data?.items ?? []),
    [sitesList.data],
  );
  const onecBySite = useMemo(
    () =>
      new Map(
        (editing?.sites ?? [])
          .filter(
            (
              s,
            ): s is CustomerCounterpartySite & {
              onec: NonNullable<CustomerCounterpartySite['onec']>;
            } => s.onec !== null,
          )
          .map((s) => [s.siteId, s.onec]),
      ),
    [editing],
  );

  const create = useMutation({
    mutationFn: (body: CustomerCounterpartyUpsert) => api.post('/customer-counterparties', body),
    onSuccess: () => {
      message.success('Контрагент создан');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CustomerCounterpartyUpsert> }) =>
      api.patch(`/customer-counterparties/${id}`, body),
    onSuccess: () => {
      message.success('Контрагент сохранён');
      closeDrawer();
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => {
      // Список объектов открыт по устаревшей версии: кто-то успел его изменить
      // (или прошла загрузка из 1С). Показываем свежие данные — правку повторить.
      if (err instanceof ApiError && err.code === 'contractor_sites_conflict') {
        message.error('Объекты у подрядчика успели изменить — откройте карточку заново');
        closeDrawer();
        void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
        return;
      }
      message.error(err.message);
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/customer-counterparties/${id}`),
    onSuccess: () => {
      message.success('Контрагент удалён');
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Права страницы. До включения матрицы значения те же, что были у ролей
  // (правит manager, удаляет admin) — так задан дефолт в PAGE_CATALOG.
  // «Создавать» и «Редактировать» разведены: раньше обе кнопки жили на одном
  // флаге, и действие «Создавать» в матрице оказалось бы мёртвым.
  const { can } = usePermissions();
  const screens = Grid.useBreakpoint();
  const canCreate = can('references.customer_counterparties', 'create');
  const canEdit = can('references.customer_counterparties', 'edit');
  const canDelete = can('references.customer_counterparties', 'delete');

  const bulk = useBulkSelection<CustomerCounterparty>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<BulkDeleteResponse>('/customer-counterparties/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) {
        message.warning(`Пропущено ${res.skipped.length}: не найдены`);
      }
      void qc.invalidateQueries({ queryKey: ['customer-counterparties'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        inn: editing.inn || undefined,
        name: editing.name,
        aliases: editing.aliases ?? [],
        address: editing.address ?? undefined,
        sites: (editing.sites ?? []).map((s) => ({ siteId: s.siteId, kind: s.kind })),
      });
    } else {
      form.resetFields();
    }
  }, [open, editing, form]);

  function openCreate() {
    setEditing(null);
    setOpen(true);
  }

  function openEdit(row: CustomerCounterparty) {
    setEditing(row);
    setOpen(true);
  }

  function closeDrawer() {
    setOpen(false);
    setEditing(null);
    form.resetFields();
  }

  function onFinish(values: CustomerCounterpartyUpsert) {
    const { sites: formSites, sitesVersion: _version, ...rest } = values;
    const sites = (formSites ?? []).map((s) => ({ siteId: s.siteId, kind: s.kind }));
    if (editing) {
      // Объекты отправляем, только если список изменили: правка названия не
      // должна спотыкаться о чужую правку объектов (409 по версии).
      const initial = (editing.sites ?? []).map((s) => ({ siteId: s.siteId, kind: s.kind }));
      const body: Partial<CustomerCounterpartyUpsert> = { ...rest };
      if (contractorSitesChanged(initial, sites)) {
        body.sites = sites;
        body.sitesVersion = editing.sitesVersion;
      }
      update.mutate({ id: editing.id, body });
    } else {
      create.mutate(sites.length > 0 ? { ...rest, sites } : rest);
    }
  }

  const submitting = create.isPending || update.isPending;

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Контрагенты
          </Typography.Title>
          <Space>
            <DebouncedSearch
              placeholder="ИНН или название"
              value={search}
              // Выбор снимаем вместе со сменой поиска: он относится к прежней
              // выдаче, а «Удалить выбранные» отправляет id, а не то, что видно.
              onChange={(v) => {
                setSearch(v);
                bulk.clear();
              }}
              style={{ width: 260 }}
            />
            {canDelete && (
              <BulkActionInline
                selectedCount={bulk.selectedCount}
                onClear={bulk.clear}
                onDelete={() => bulkDel.mutate(Array.from(bulk.selectedIds))}
                deleting={bulkDel.isPending}
                confirmTitle={`Удалить ${bulk.selectedCount} ${pluralizeCp(bulk.selectedCount)}?`}
              />
            )}
            {canCreate && (
              <Button type="primary" onClick={openCreate}>
                Добавить
              </Button>
            )}
          </Space>
        </Space>
      }
    >
      <ResponsiveTable<CustomerCounterparty>
        items={list.data?.items ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        rowSelection={canDelete ? bulk.selection : undefined}
        onRowClick={canEdit ? openEdit : undefined}
        // Сортировка и фильтр в каждой колонке, если сервер отдал весь список
        // (иначе — подсказка уточнить поиском, см. ResponsiveTable).
        autoColumnTools={{ total: list.data?.total ?? 0 }}
        columns={[
          {
            title: 'ИНН',
            dataIndex: 'inn',
            // 12 цифр ИП со стрелкой и воронкой; без ширины колонка забирала место
            // у «Названия», и на 1024 px его заголовок рвался посреди слова.
            width: 130,
            sorter: stringSorter<CustomerCounterparty>((r) => r.inn || null),
            render: (v: string) => v || '—',
          },
          {
            title: 'Название',
            dataIndex: 'name',
            sorter: stringSorter<CustomerCounterparty>((r) => r.name),
          },
          {
            title: 'Объекты и вид',
            key: 'sites',
            dataIndex: 'sites',
            // Самая длинная метка «ПРИМ14 · Реализация + давальческий» — ~240 px;
            // на широком экране — две короткие метки в строку, строки ниже.
            width: screens.xl ? 340 : 260,
            // В фильтре каждая метка отдельным значением: «ЗИЛ18 · Давальческий».
            tools: {
              text: (r) => (r.sites ?? []).map(contractorSiteLabel),
              sortValue: (r) => r.sites?.length ?? 0,
            },
            render: (_: unknown, r: CustomerCounterparty) => (
              <ContractorSiteTags sites={r.sites ?? []} />
            ),
          },
          {
            title: 'Альтернативные названия',
            dataIndex: 'aliases',
            // Подпись длинная: уже ~260px она с иконками уходит в две строки.
            width: 280,
            // На экране — теги; в фильтре каждое название отдельным значением.
            tools: { text: (r) => r.aliases ?? [] },
            render: (v: string[] | null | undefined) =>
              v && v.length > 0 ? (
                <Space size={[4, 4]} wrap>
                  {v.map((a) => (
                    <Tag key={a} style={{ marginInlineEnd: 0 }}>
                      {a}
                    </Tag>
                  ))}
                </Space>
              ) : (
                '—'
              ),
          },
          ...(canDelete
            ? [
                {
                  title: '',
                  key: 'actions',
                  width: 80,
                  render: (_: unknown, r: CustomerCounterparty) => (
                    <Popconfirm
                      title="Удалить контрагента?"
                      description="Действие необратимо."
                      okText="Да, удалить"
                      cancelText="Нет"
                      okButtonProps={{ danger: true }}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        del.mutate(r.id);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        loading={del.isPending && del.variables === r.id}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
        cardRender={(r) => (
          <Card style={{ width: '100%' }} size="small" onClick={() => canEdit && openEdit(r)}>
            <Space direction="vertical" size={4}>
              <Typography.Text strong>{r.name}</Typography.Text>
              <Typography.Text type="secondary">ИНН {r.inn || '—'}</Typography.Text>
              {r.address && <Typography.Text type="secondary">{r.address}</Typography.Text>}
              <ContractorSitesText sites={r.sites ?? []} />
            </Space>
          </Card>
        )}
      />
      <Drawer
        open={open}
        onClose={closeDrawer}
        title={editing ? 'Контрагент' : 'Новый контрагент'}
        width={560}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<CustomerCounterpartyUpsert> form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="inn" label="ИНН (необязательно)">
            <Input />
          </Form.Item>
          <Form.Item
            name="aliases"
            label="Альтернативные названия"
            extra="Введите альтернативное написание и нажмите Enter."
          >
            <Select<string[]>
              mode="tags"
              placeholder="Например: Лютик, ООО «Лютик»"
              tokenSeparators={[',']}
            />
          </Form.Item>
          <Form.Item name="address" label="Адрес">
            <Input.TextArea rows={2} />
          </Form.Item>
          <ContractorSitesFormList
            form={form}
            siteOptions={siteOptions}
            sitesLoading={sitesList.isLoading}
            onecBySite={onecBySite}
          />
          <Button type="primary" htmlType="submit" loading={submitting} block size="large">
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}

// Склонение «контрагент»: 1 контрагент / 2-4 контрагента / 5+ контрагентов.
function pluralizeCp(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'контрагентов';
  if (last === 1) return 'контрагента';
  if (last >= 2 && last <= 4) return 'контрагента';
  return 'контрагентов';
}
