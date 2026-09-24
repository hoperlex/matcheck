import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, ProfileOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EdoAccountCreate,
  EdoAccountDto,
  EdoAccountPatch,
  EdoCheckResult,
  EdoInventoryReport,
  EdoJobQueued,
  EdoJournalSummary,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { describeAccessCheck } from './edo-access-check';
import {
  INVENTORY_PERIODS,
  inventorySince,
  type InventoryPeriod,
} from './edo-inventory-period';

/**
 * Возраст refresh-токена: он живёт 30 дней, и счётчик продлевается только при
 * использовании. Учётка с выключенным опросом умирает молча, поэтому возраст
 * показывается рядом с именем, а не прячется в подробностях.
 */
const TOKEN_WARN_DAYS = 25;

function TokenAge({ days }: { days: number | null }) {
  if (days === null) return <Typography.Text type="secondary">—</Typography.Text>;
  if (days >= TOKEN_WARN_DAYS) {
    return (
      <Tooltip title="Refresh-токен действует 30 дней с момента последнего использования. Включите опрос или выпустите новый токен в Кабинете интегратора.">
        <Tag color="red">{days} дн.</Tag>
      </Tooltip>
    );
  }
  return <Tag color="green">{days} дн.</Tag>;
}

/**
 * Значение вставлено вместе с именем параметра.
 *
 * Ровно так и сорвалась первая настройка: в поле попало `clientId=ci_…`, и
 * сервис авторизации ответил `invalid_client` — тем же кодом, что и на неверный
 * ключ. Отличить одно от другого по ответу невозможно, поэтому ловим на входе.
 *
 * Проверка именно предупреждающая, а не «умная»: молча срезать приставку у
 * чужого секрета опаснее, чем попросить человека вставить значение заново.
 */
const PARAM_PREFIX = /^\s*(client[_-]?id|client[_-]?secret|refresh[_-]?token|grant[_-]?type)\s*=/i;

const noParamPrefix = {
  validator: (_: unknown, value?: string) =>
    value && PARAM_PREFIX.test(value)
      ? Promise.reject(
          new Error('Похоже, скопировано вместе с именем параметра — вставьте только значение после «=»'),
        )
      : Promise.resolve(),
};

/**
 * В client_id вставлен адрес почты.
 *
 * Логин сотрудника в OIDC не передаётся вовсе — он «зашит» в refresh-токен, —
 * но поле выглядит как обычный текстовый ввод, и браузер охотно подставляет
 * туда сохранённый адрес. На боевой настройке так и вышло: вместо `ci_su-10`
 * ушло `esenov.m.n@su10.ru`, а сервис авторизации ответил тем же
 * `invalid_client`, что и на неверный ключ.
 */
const notAnEmail = {
  validator: (_: unknown, value?: string) =>
    value && value.includes('@')
      ? Promise.reject(
          new Error(
            'Похоже на адрес почты. В client_id нужен идентификатор приложения из Кабинета интегратора (ci_…), логин там не используется',
          ),
        )
      : Promise.resolve(),
};

export default function AdminEdoAccountsPage() {
  const qc = useQueryClient();
  // Страницу можно выдать на просмотр отдельно от управления, поэтому контролы
  // спрашивают действие, а не факт открытия страницы.
  const { can } = usePermissions();
  const canCreate = can('admin.edo_accounts', 'create');
  // Действия `edit` у страницы нет вовсе, поэтому обслуживание гейтим по правам
  // управления учётками: у кого есть заведение или удаление, у того есть и
  // обслуживание. Роль с одним лишь просмотром кнопок не увидит — на сервере
  // эти маршруты ей закрыты (matrixOnly: deny в route-map).
  const canManage = canCreate || can('admin.edo_accounts', 'delete');
  const [open, setOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<EdoCheckResult | null>(null);
  // Какую учётную запись проверяем: без этого выбранный ящик некуда записать.
  const [checkedAccountId, setCheckedAccountId] = useState<string | null>(null);
  const [journal, setJournal] = useState<EdoJournalSummary | null>(null);
  // Итог проверки доступа в словах: правило живёт отдельно от вёрстки, потому
  // что «ящиков нет», «прав мало» и «учётка заблокирована» лечатся по-разному.
  const verdict = checkResult ? describeAccessCheck(checkResult) : null;
  // Окно осмотра: выбор периода и результат прошлой разведки. Раньше кнопка
  // запускала работу молча, а отчёт оставался только в базе.
  const [inventoryFor, setInventoryFor] = useState<EdoAccountDto | null>(null);
  const [inventoryPeriod, setInventoryPeriod] = useState<InventoryPeriod>('d90');
  const [editing, setEditing] = useState<EdoAccountDto | null>(null);
  const [editForm] = Form.useForm<EdoAccountPatch>();
  const [form] = Form.useForm<EdoAccountCreate>();

  const list = useQuery({
    queryKey: ['admin', 'edo-accounts'],
    queryFn: () => api.get<EdoAccountDto[]>('/admin/edo-accounts'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'edo-accounts'] });

  // Для окна осмотра берём свежую запись из списка, а не снимок на момент
  // открытия: работа идёт в очереди, и «Обновить» иначе показывал бы прежний
  // отчёт. Снимок остаётся запасным вариантом, если запись из списка пропала.
  const inventoryRow = inventoryFor
    ? ((list.data ?? []).find((a) => a.id === inventoryFor.id) ?? inventoryFor)
    : null;

  const create = useMutation({
    mutationFn: (body: EdoAccountCreate) => api.post('/admin/edo-accounts', body),
    onSuccess: () => {
      message.success('Учётная запись добавлена. Проверьте доступ, прежде чем включать опрос.');
      setOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const togglePoll = useMutation({
    mutationFn: ({ id, pollEnabled }: { id: string; pollEnabled: boolean }) =>
      api.patch(`/admin/edo-accounts/${id}`, { pollEnabled }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => message.error(err.message),
  });

  const check = useMutation({
    mutationFn: (id: string) => api.post<EdoCheckResult>(`/admin/edo-accounts/${id}/check`),
    onSuccess: (r, id) => {
      setCheckResult(r);
      setCheckedAccountId(id);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Ящик выбирается прямо из результата проверки: переписывать GUID руками —
  // лишний повод ошибиться, а ошибка здесь тихая (чужой ящик отвечает 403).
  const chooseBox = useMutation({
    mutationFn: ({ id, boxId, inn }: { id: string; boxId: string; inn: string | null }) =>
      api.patch(`/admin/edo-accounts/${id}`, { boxId, ...(inn ? { orgInn: inn } : {}) }),
    onSuccess: () => {
      message.success('Ящик выбран');
      setCheckResult(null);
      setCheckedAccountId(null);
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Раньше кнопка держала браузер до десяти минут: импорт шёл прямо в процессе
  // API. Теперь это работа в очереди — ответ сразу, ход виден по состоянию
  // учётной записи.
  const sync = useMutation({
    mutationFn: (id: string) => api.post<EdoJobQueued>(`/admin/edo-accounts/${id}/sync`),
    onSuccess: () => message.success('Синхронизация запущена'),
    onError: (err: Error) => message.error(err.message),
  });

  // Правка учётной записи. Пустые поля секретов означают «оставить прежние»:
  // показать их форме неоткуда — наружу они не отдаются.
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: EdoAccountPatch }) =>
      api.patch(`/admin/edo-accounts/${id}`, body),
    onSuccess: () => {
      message.success('Сохранено');
      setEditing(null);
      editForm.resetFields();
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/edo-accounts/${id}`),
    onSuccess: () => {
      message.success('Учётная запись удалена');
      invalidate();
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Журнал приёма: без него на вопрос «почему документ не приехал» пришлось бы
  // отвечать запросом в базу.
  const openJournal = useMutation({
    mutationFn: (id: string) =>
      api.get<EdoJournalSummary>(`/admin/edo-accounts/${id}/journal?limit=50`),
    onSuccess: (r) => setJournal(r),
    onError: (err: Error) => message.error(err.message),
  });

  const inventory = useMutation({
    mutationFn: ({ id, since }: { id: string; since?: string }) =>
      api.post<EdoJobQueued>(`/admin/edo-accounts/${id}/inventory`, since ? { since } : {}),
    onSuccess: () =>
      message.success(
        'Разведка запущена: ничего не импортируется. Отчёт появится здесь через минуту — нажмите «Обновить».',
      ),
    onError: (err: Error) => message.error(err.message),
  });

  /**
   * Подписи оставлены только у действий, которыми пользуются по ходу настройки.
   * Редкие — журнал, правка, удаление — свёрнуты в иконки с подсказками, как на
   * странице пользователей: иначе шесть подписанных кнопок переносятся и строка
   * таблицы растёт до трёх этажей.
   *
   * `wrap` оставлен намеренно: в таблице колонка теперь получает достаточную
   * ширину и переносить нечего, но эти же кнопки показываются в карточке на
   * узком экране — без переноса они вылезли бы за её край.
   */
  const actions = (r: EdoAccountDto) => (
    <Space size={4} wrap>
      <Button size="small" onClick={() => check.mutate(r.id)} loading={check.isPending}>
        Проверить доступ
      </Button>
      <Tooltip title="Пройти по ленте и показать, какие документы лежат в ящике. Ничего не импортирует.">
        <Button
          size="small"
          onClick={() => setInventoryFor(r)}
          disabled={!r.boxId}
        >
          Осмотреть ящик
        </Button>
      </Tooltip>
      <Button size="small" onClick={() => sync.mutate(r.id)} loading={sync.isPending}>
        Синхронизировать
      </Button>
      <Tooltip title="Журнал приёма">
        <Button
          size="small"
          type="text"
          icon={<ProfileOutlined />}
          onClick={() => openJournal.mutate(r.id)}
          loading={openJournal.isPending}
        />
      </Tooltip>
      <Tooltip title="Изменить">
        <Button
          size="small"
          type="text"
          icon={<EditOutlined />}
          onClick={() => {
            setEditing(r);
            editForm.setFieldsValue({
              name: r.name,
              environment: r.environment,
              orgInn: r.orgInn,
              ...(r.boxId ? { boxId: r.boxId } : {}),
            });
          }}
        />
      </Tooltip>
      <Popconfirm
        title="Удалить учётную запись?"
        description="Настройки и журнал приёма будут удалены. Документы, уже попавшие в портал, останутся."
        okText="Удалить"
        cancelText="Отмена"
        okButtonProps={{ danger: true }}
        onConfirm={() => remove.mutate(r.id)}
      >
        <Tooltip title="Удалить">
          <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={remove.isPending} />
        </Tooltip>
      </Popconfirm>
    </Space>
  );

  return (
    <StickyPageHeader
      header={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            ЭДО учётки (Диадок)
          </Typography.Title>
          {canCreate && (
            <Button type="primary" onClick={() => setOpen(true)}>
              Добавить
            </Button>
          )}
        </Space>
      }
    >
      <ResponsiveTable<EdoAccountDto>
        items={list.data ?? []}
        loading={list.isLoading}
        rowKey="id"
        numbered
        columns={[
          { title: 'Имя', dataIndex: 'name', width: 180, ellipsis: true },
          {
            title: 'Площадка',
            dataIndex: 'environment',
            width: 96,
            render: (e: EdoAccountDto['environment']) => (
              <Tag color={e === 'production' ? 'blue' : 'orange'}>
                {e === 'production' ? 'боевая' : 'тестовая'}
              </Tag>
            ),
          },
          {
            // Отказ `invalid_client` выглядит одинаково и при неверном ключе, и
            // при опечатке в идентификаторе, и при лишнем пробеле из буфера
            // обмена. Поэтому показываем, что именно сохранено: идентификатор
            // целиком (он не секрет) и длины секретов — их можно сверить с
            // Кабинетом интегратора, не раскрывая значений.
            title: 'Приложение',
            key: 'app',
            width: 140,
            render: (_: unknown, r: EdoAccountDto) =>
              r.clientId ? (
                <Tooltip
                  title={
                    <span>
                      Ключ приложения: {r.clientSecretLength ?? 0} симв., отпечаток{' '}
                      <b>{r.clientSecretFingerprint ?? '—'}</b>
                      <br />
                      Refresh-токен: {r.refreshTokenLength ?? 0} симв., отпечаток{' '}
                      <b>{r.refreshTokenFingerprint ?? '—'}</b>
                      <br />
                      Сверить у себя: printf %s &apos;ЗНАЧЕНИЕ&apos; | sha256sum | cut -c1-8
                    </span>
                  }
                >
                  <Typography.Text code copyable={{ text: r.clientId }}>
                    {r.clientId.length > 12 ? `${r.clientId.slice(0, 12)}…` : r.clientId}
                  </Typography.Text>
                </Tooltip>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Ящик',
            dataIndex: 'boxId',
            width: 104,
            render: (b: string | null) =>
              b ? (
                <Typography.Text code>{b.slice(0, 8)}…</Typography.Text>
              ) : (
                <Tag>не выбран</Tag>
              ),
          },
          {
            title: 'Опрос',
            key: 'poll',
            width: 72,
            render: (_: unknown, r: EdoAccountDto) => (
              <Switch
                size="small"
                checked={r.pollEnabled}
                disabled={!canManage || togglePoll.isPending}
                onChange={(v) => togglePoll.mutate({ id: r.id, pollEnabled: v })}
              />
            ),
          },
          {
            title: 'Токен',
            key: 'token',
            width: 84,
            render: (_: unknown, r: EdoAccountDto) => <TokenAge days={r.refreshTokenAgeDays} />,
          },
          {
            title: 'Состояние',
            key: 'state',
            width: 116,
            render: (_: unknown, r: EdoAccountDto) =>
              r.lastError ? (
                <Tooltip title={r.lastError}>
                  <Tag color="red">ошибка</Tag>
                </Tooltip>
              ) : r.lastOkAt ? (
                <Tag color="green">в порядке</Tag>
              ) : (
                <Tag>не проверялась</Tag>
              ),
          },
          {
            title: 'Действия',
            key: 'a',
            render: (_: unknown, r: EdoAccountDto) =>
              canManage ? actions(r) : <Typography.Text type="secondary">—</Typography.Text>,
          },
        ]}
        cardRender={(r) => (
          <Card size="small" style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{r.name}</Typography.Text>
                <Tag color={r.environment === 'production' ? 'blue' : 'orange'}>
                  {r.environment === 'production' ? 'боевая' : 'тестовая'}
                </Tag>
                <TokenAge days={r.refreshTokenAgeDays} />
              </Space>
              {r.lastError && <Typography.Text type="danger">{r.lastError}</Typography.Text>}
              {canManage && actions(r)}
            </Space>
          </Card>
        )}
      />

      <Modal
        open={journal !== null}
        onCancel={() => setJournal(null)}
        footer={null}
        title="Журнал приёма"
        width={860}
      >
        {journal && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {journal.entries.length === 0 && (
              <Alert
                type="info"
                showIcon
                message="Пока пусто"
                description="Ни одного вложения не забирали. Проверьте, что выбран ящик, и запустите синхронизацию."
              />
            )}
            {journal.eventsPending > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`Незакрытых событий: ${journal.eventsPending}`}
                description="Курсор ленты стоит на первом из них и не пойдёт дальше, пока они не разберутся."
              />
            )}
            <Space wrap>
              {journal.byTransport.map((s2) => (
                <Tag key={`t-${s2.status}`}>
                  файлы · {s2.status}: {s2.count}
                </Tag>
              ))}
              {journal.byRoute.map((s2) => (
                <Tag key={`r-${s2.status}`} color="blue">
                  разбор · {s2.status}: {s2.count}
                </Tag>
              ))}
            </Space>
            <ResponsiveTable<EdoJournalSummary['entries'][number]>
              items={journal.entries}
              rowKey="id"
              columns={[
                { title: 'Документ', dataIndex: 'documentNumber', render: (n: string | null) => n ?? '—' },
                { title: 'Тип', dataIndex: 'documentType', render: (t: string | null) => t ?? '—' },
                { title: 'Версия', dataIndex: 'documentVersion', render: (v: string | null) => v ?? '—' },
                { title: 'Файл', dataIndex: 'transportStatus' },
                { title: 'Разбор', dataIndex: 'routeStatus' },
                { title: 'Попыток', dataIndex: 'attempts' },
                {
                  title: 'Причина',
                  dataIndex: 'lastError',
                  render: (e: string | null) =>
                    e ? (
                      <Typography.Text type="secondary">{e}</Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
              ]}
              cardRender={(e) => (
                <Card size="small" style={{ width: '100%' }}>
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{e.documentNumber ?? e.entityId}</Typography.Text>
                    <Typography.Text type="secondary">
                      файл: {e.transportStatus} · разбор: {e.routeStatus}
                    </Typography.Text>
                    {e.lastError && <Typography.Text type="secondary">{e.lastError}</Typography.Text>}
                  </Space>
                </Card>
              )}
            />
          </Space>
        )}
      </Modal>

      {/*
        Осмотр ящика. Период выбирается здесь, а не берётся молча из отсечки
        учётной записи: подключение может быть сделано сегодня, и с ней разведка
        покажет пустоту, тогда как вопрос ровно обратный — что в ящике вообще
        лежит. Отсечку импорта это не меняет.
      */}
      <Modal
        open={inventoryFor !== null}
        onCancel={() => setInventoryFor(null)}
        footer={null}
        title="Осмотр ящика"
        width={760}
      >
        {inventoryRow && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="Разведка ничего не импортирует"
              description="Проход по ленте только считает, какие документы лежат в ящике. Ни карточек, ни записей в журнале приёма не появится."
            />
            <Space wrap>
              <Select<InventoryPeriod>
                value={inventoryPeriod}
                onChange={setInventoryPeriod}
                options={INVENTORY_PERIODS}
                style={{ width: 220 }}
              />
              <Button
                type="primary"
                loading={inventory.isPending}
                onClick={() =>
                  inventory.mutate({
                    id: inventoryRow.id,
                    since: inventorySince(inventoryPeriod),
                  })
                }
              >
                Запустить осмотр
              </Button>
              {/* Работа идёт в очереди, поэтому отчёт приходится переспрашивать. */}
              <Button onClick={() => invalidate()} loading={list.isFetching}>
                Обновить
              </Button>
            </Space>

            {inventoryRow.lastInventory ? (
              <>
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="Просмотрено событий">
                    {inventoryRow.lastInventory.eventsSeen}
                  </Descriptions.Item>
                  <Descriptions.Item label="Документов в них">
                    {inventoryRow.lastInventory.entitiesSeen}
                  </Descriptions.Item>
                  <Descriptions.Item label="Период" span={2}>
                    {inventoryRow.lastInventory.from
                      ? new Date(inventoryRow.lastInventory.from).toLocaleString()
                      : 'с начала ленты'}{' '}
                    —{' '}
                    {inventoryRow.lastInventory.to
                      ? new Date(inventoryRow.lastInventory.to).toLocaleString()
                      : '—'}
                  </Descriptions.Item>
                  {/*
                    Пустой период в отчёте означает не «ящик пуст», а «время
                    события не разобралось». Показываем это прямо, иначе разница
                    видна только по коду.
                  */}
                  <Descriptions.Item label="Время событий" span={2}>
                    {inventoryRow.lastInventory.timedEvents === undefined ? (
                      <Typography.Text type="secondary">
                        не считалось — отчёт снят до появления проверки
                      </Typography.Text>
                    ) : inventoryRow.lastInventory.timedEvents === 0 ? (
                      <Typography.Text type="warning">
                        не нашлось ни у одного события — период показать не из чего
                      </Typography.Text>
                    ) : (
                      <>
                        {inventoryRow.lastInventory.timedEvents} из{' '}
                        {inventoryRow.lastInventory.eventsSeen}
                        {inventoryRow.lastInventory.timeSource === 'message'
                          ? ' (из сообщения, а не из события)'
                          : ''}
                      </>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="Когда смотрели" span={2}>
                    {inventoryRow.lastInventoryAt
                      ? new Date(inventoryRow.lastInventoryAt).toLocaleString()
                      : '—'}
                  </Descriptions.Item>
                </Descriptions>
                {inventoryRow.lastInventory.truncated && (
                  <Alert
                    type="warning"
                    showIcon
                    message="Обход остановлен на пределе"
                    description="Показана часть ленты: разведка ограничена по числу страниц и событий. Возьмите более короткий период, чтобы увидеть картину целиком."
                  />
                )}
                <Typography.Text strong>Что лежит в ящике</Typography.Text>
                <ResponsiveTable<EdoInventoryReport['byType'][number]>
                  items={inventoryRow.lastInventory.byType}
                  rowKey={(b) => `${b.typeNamedId}|${b.function ?? ''}|${b.version ?? ''}`}
                  columns={[
                    { title: 'Тип документа', dataIndex: 'typeNamedId', ellipsis: true },
                    {
                      title: 'Функция',
                      dataIndex: 'function',
                      width: 120,
                      render: (f: string | null) => f ?? '—',
                    },
                    {
                      title: 'Версия',
                      dataIndex: 'version',
                      width: 120,
                      render: (v: string | null) => v ?? '—',
                    },
                    {
                      title: 'Формат',
                      dataIndex: 'formalized',
                      width: 150,
                      render: (f: boolean) =>
                        f ? (
                          <Tag color="green">машиночитаемый</Tag>
                        ) : (
                          <Tag>скан или PDF</Tag>
                        ),
                    },
                    { title: 'Сколько', dataIndex: 'count', width: 90 },
                  ]}
                  cardRender={(b) => (
                    <Card size="small" style={{ width: '100%' }}>
                      <Space direction="vertical" size={0}>
                        <Typography.Text strong>{b.typeNamedId}</Typography.Text>
                        <Typography.Text type="secondary">
                          функция: {b.function ?? '—'} · версия: {b.version ?? '—'} · {b.count} шт.
                        </Typography.Text>
                        {b.formalized ? (
                          <Tag color="green">машиночитаемый</Tag>
                        ) : (
                          <Tag>скан или PDF</Tag>
                        )}
                      </Space>
                    </Card>
                  )}
                  emptyText="Входящих документов за этот период нет"
                />
              </>
            ) : (
              <Typography.Text type="secondary">
                Осмотр ещё не проводился. Выберите период и запустите — это безопасно.
              </Typography.Text>
            )}
          </Space>
        )}
      </Modal>

      <Modal
        open={checkResult !== null}
        onCancel={() => {
          setCheckResult(null);
          setCheckedAccountId(null);
        }}
        footer={null}
        title="Доступ к Диадоку"
        width={620}
      >
        {checkResult && (
          <Space direction="vertical" style={{ width: '100%' }}>
            {/*
              Какое из состояний показать, решает describeAccessCheck: пустой
              список ящиков, ограниченный доступ и блокировка — разные неполадки
              с разными действиями, и правило проверяется тестом отдельно от
              вёрстки.
            */}
            {verdict && verdict.kind !== 'ok' && (
              <Alert
                type="warning"
                showIcon
                message={verdict.title}
                description={verdict.description}
              />
            )}
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Уровень доступа">
                {checkResult.employee.documentAccessLevel ??
                  (checkResult.boxes.length === 0 ? 'не проверялся — нет ящика' : '—')}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Text strong>Доступные ящики</Typography.Text>
            {checkResult.boxes.length === 0 && (
              <Typography.Text type="secondary">
                Список пуст. Пока в нём не появится ящик, читать документы не из чего: запрос к
                ленте адресуется конкретным ящиком.
              </Typography.Text>
            )}
            {checkResult.boxes.map((b) => {
              const account = (list.data ?? []).find((a) => a.id === checkedAccountId);
              const isCurrent = account?.boxId === b.boxId;
              // Менять ящик у учётной записи, которая уже читала ленту, нельзя:
              // курсор указывает на позицию в ДРУГОМ ящике. Сервер это
              // запрещает, поэтому и кнопку не показываем.
              const locked = Boolean(account?.lastEventAt) && !isCurrent;
              return (
                <Card key={b.boxId} size="small">
                  <Space direction="vertical" size={0} style={{ width: '100%' }}>
                    <Typography.Text>{b.title || '(без названия)'}</Typography.Text>
                    <Typography.Text type="secondary">
                      ИНН {b.inn ?? '—'} · КПП {b.kpp ?? '—'}
                    </Typography.Text>
                    <Typography.Text copyable code>
                      {b.boxId}
                    </Typography.Text>
                    {isCurrent ? (
                      <Tag color="green">выбран</Tag>
                    ) : locked ? (
                      <Typography.Text type="secondary">
                        учётная запись уже читала ленту другого ящика — заведите новую
                      </Typography.Text>
                    ) : (
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0 }}
                        loading={chooseBox.isPending}
                        onClick={() =>
                          checkedAccountId &&
                          chooseBox.mutate({ id: checkedAccountId, boxId: b.boxId, inn: b.inn })
                        }
                      >
                        Использовать этот ящик
                      </Button>
                    )}
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Modal>

      <Drawer
        open={editing !== null}
        onClose={() => {
          setEditing(null);
          editForm.resetFields();
        }}
        title={`Изменить: ${editing?.name ?? ''}`}
        width={520}
        destroyOnClose
        maskClosable={false}
      >
        <Form<EdoAccountPatch>
          form={editForm}
          layout="vertical"
          onFinish={(v) => {
            if (!editing) return;
            // Пустые поля секретов не отправляем вовсе: на сервере «поле не
            // передано» означает «оставить прежнее», а пустая строка была бы
            // попыткой стереть ключ.
            const credentials = {
              ...(v.credentials?.clientId ? { clientId: v.credentials.clientId } : {}),
              ...(v.credentials?.clientSecret ? { clientSecret: v.credentials.clientSecret } : {}),
              ...(v.credentials?.refreshToken ? { refreshToken: v.credentials.refreshToken } : {}),
            };
            update.mutate({
              id: editing.id,
              body: {
                name: v.name,
                environment: v.environment,
                orgInn: v.orgInn || null,
                ...(v.boxId ? { boxId: v.boxId } : {}),
                ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
              },
            });
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Вставляйте только значения"
            description={
              <>
                Без имён параметров и знака равенства: в поле должно быть{' '}
                <Typography.Text code>ci_…</Typography.Text>, а не{' '}
                <Typography.Text code>clientId=ci_…</Typography.Text>. Поля секретов можно
                оставить пустыми — тогда прежние значения сохранятся. Сверить сохранённое с
                оригиналом, не раскрывая его:{' '}
                <Typography.Text code>
                  printf %s &apos;ЗНАЧЕНИЕ&apos; | sha256sum | cut -c1-8
                </Typography.Text>
              </>
            }
          />
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="environment" label="Площадка">
            <Select
              options={[
                { value: 'production', label: 'Боевая' },
                { value: 'staging', label: 'Тестовая' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientId']}
            rules={[noParamPrefix, notAnEmail]}
            label="client_id"
            extra={
              editing?.clientId ? `Сейчас сохранено: ${editing.clientId}` : 'Сейчас не заполнен'
            }
          >
            <Input autoComplete="off" placeholder="оставьте пустым, чтобы не менять" />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientSecret']}
            rules={[noParamPrefix]}
            label="Ключ приложения (client_secret)"
            extra={
              editing?.clientSecretLength
                ? `Сейчас сохранено: ${editing.clientSecretLength} символов, отпечаток ${
                    editing.clientSecretFingerprint ?? '—'
                  }`
                : 'Сейчас не заполнен'
            }
          >
            <Input.Password autoComplete="new-password" placeholder="оставьте пустым, чтобы не менять" />
          </Form.Item>
          <Form.Item
            name={['credentials', 'refreshToken']}
            rules={[noParamPrefix]}
            label="Refresh-токен"
            extra={
              editing?.refreshTokenLength
                ? `Сейчас сохранено: ${editing.refreshTokenLength} символов, отпечаток ${
                    editing.refreshTokenFingerprint ?? '—'
                  }`
                : 'Сейчас не заполнен'
            }
          >
            <Input.Password autoComplete="new-password" placeholder="оставьте пустым, чтобы не менять" />
          </Form.Item>
          <Form.Item
            name="boxId"
            label="Box ID"
            extra="После первого чтения ленты ящик менять нельзя — понадобится новая учётная запись."
          >
            <Input />
          </Form.Item>
          <Form.Item name="orgInn" label="ИНН нашей организации">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={update.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Новая учётная запись ЭДО"
        width={520}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
      >
        <Form<EdoAccountCreate>
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{
            provider: 'diadoc',
            isActive: true,
            environment: 'production',
            credentials: { authMode: 'oidc_refresh' },
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Где взять доступы"
            description={
              <>
                client_id выдаёт менеджер Диадока, ключ приложения и первичный refresh-токен
                выпускаются в Кабинете интегратора. Используйте сервисную учётную запись, а не
                личную: при увольнении сотрудника интеграция не должна падать.
              </>
            }
          />
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Например: Диадок СУ-10" />
          </Form.Item>
          <Form.Item
            name="environment"
            label="Площадка"
            rules={[{ required: true }]}
            extra="Ящик, выданный на одной площадке, на другой не работает."
          >
            <Select
              options={[
                { value: 'production', label: 'Боевая' },
                { value: 'staging', label: 'Тестовая' },
              ]}
            />
          </Form.Item>
          <Form.Item name={['credentials', 'authMode']} hidden initialValue="oidc_refresh">
            <Input />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientId']}
            label="client_id"
            rules={[{ required: true }, noParamPrefix, notAnEmail]}
            extra="Только значение: ci_… , без «clientId=»."
          >
            {/* Браузер принимает это поле за адрес почты и подставляет туда
                сохранённый логин — именно так в client_id однажды попал
                esenov.m.n@su10.ru вместо ci_su-10. */}
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name={['credentials', 'clientSecret']}
            label="Ключ приложения (client_secret)"
            rules={[{ required: true }, noParamPrefix]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name={['credentials', 'refreshToken']}
            label="Первичный refresh-токен"
            rules={[{ required: true }, noParamPrefix]}
            extra="Действует 30 дней с момента последнего использования."
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="boxId"
            label="Box ID"
            extra="Можно не заполнять: подставится после «Проверить доступ»."
          >
            <Input />
          </Form.Item>
          <Form.Item name="orgInn" label="ИНН нашей организации">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={create.isPending}>
            Сохранить
          </Button>
        </Form>
      </Drawer>
    </StickyPageHeader>
  );
}
