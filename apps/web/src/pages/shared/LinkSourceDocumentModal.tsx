import { useMemo, useState } from 'react';
import { Alert, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  SourceDirection,
  SourceDocument,
  SourceDocumentListResponseSchema,
} from '@matcheck/contracts';
import type { z } from 'zod';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/auth';

type List = z.infer<typeof SourceDocumentListResponseSchema>;

/**
 * Модалка ручной привязки УПД к приёмке/отгрузке «Без документа».
 * Видна только admin/manager (фильтрация по роли — на стороне вызывающей формы).
 * Показывает только непривязанные УПД нужного направления; по умолчанию
 * фильтрует по siteId приёмки/отгрузки, но даёт переключатель «все объекты».
 */
export function LinkSourceDocumentModal({
  open,
  onCancel,
  onPick,
  direction,
  siteId,
  busy,
  error,
}: {
  open: boolean;
  onCancel: () => void;
  onPick: (upd: SourceDocument) => void;
  direction: SourceDirection;
  siteId: string | null;
  busy?: boolean;
  error?: string | null;
}) {
  const [allSites, setAllSites] = useState(false);
  // «Мои» — оставить только УПД, загруженные текущим пользователем
  // (createdByUserId === user.id). По умолчанию выключено — менеджеру
  // обычно нужно видеть весь пул, но при большом списке этот фильтр
  // помогает быстро найти «свои» УПД. EDO/mail-полученные документы
  // имеют createdByUserId=null и при включённом «Мои» отфильтруются.
  const [onlyMine, setOnlyMine] = useState(false);
  // «Несколько поставок» — показывать в том числе уже привязанные УПД,
  // чтобы менеджер мог использовать одну УПД для нескольких приёмок/
  // отгрузок (сценарий: одна УПД на 50 т арматуры доставлена 4-5
  // рейсами). После миграции 0063 UNIQUE по source_document_id снят —
  // бэк больше не блокирует повторную привязку. По умолчанию выключено
  // (поведение 1:1 как раньше). См. комментарий к assertSourcesAvailable*.
  const [multiple, setMultiple] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const list = useQuery({
    // Кешируем РАЗНЫЕ ключи под выключенным/включенным «Несколько поставок»
    // — потому что бэк возвращает разные подмножества (unaccepted vs all).
    queryKey: ['source-documents', 'link-upd', direction, multiple ? 'all' : 'unaccepted'],
    queryFn: () => {
      const qs = new URLSearchParams({
        kind: 'upd,transport_waybill,os2_transfer',
        direction,
        // multiple=true → показываем ВСЕ УПД направления (включая уже
        // привязанные к другим приёмкам). По умолчанию unaccepted=true
        // (только свободные) — UX как раньше.
        unaccepted: multiple ? 'false' : 'true',
        limit: '200',
      });
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    enabled: open,
  });

  const items = list.data?.items ?? [];
  const filtered = useMemo(() => {
    let result = items;
    // Фильтр по объекту (как раньше): УПД того же siteId либо без siteId.
    if (!allSites && siteId) {
      result = result.filter((r) => r.siteId === siteId || r.siteId === null);
    }
    // Фильтр «Мои»: только УПД, загруженные текущим юзером. Если в
    // current user нет id (что не должно случаться при открытой модалке) —
    // фильтр пропускается, чтобы не показать пустой список.
    if (onlyMine && currentUserId) {
      result = result.filter((r) => r.createdByUserId === currentUserId);
    }
    return result;
  }, [items, siteId, allSites, onlyMine, currentUserId]);

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title="Привязать УПД"
      width="95vw"
      style={{ top: 12, paddingBottom: 0, maxWidth: 'none' }}
      styles={{
        // Body высоты 95vh минус заголовок (~50) — скролл идёт ВНУТРИ
        // таблицы (scroll.y ниже), а не на уровне body или страницы.
        // Раньше при длинном списке УПД таблица выходила за нижний край
        // экрана и приходилось скроллить всю страницу.
        body: {
          padding: '12px 16px',
          maxHeight: 'calc(95vh - 56px)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
      footer={null}
      destroyOnClose
      maskClosable={false}
      keyboard={false}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%', flex: 1, minHeight: 0 }}>
        {error ? <Alert type="error" message={error} showIcon /> : null}
        <Space size={24} wrap>
          {siteId ? (
            <Space>
              <Switch checked={allSites} onChange={setAllSites} disabled={busy} />
              <Typography.Text>Показать УПД всех объектов</Typography.Text>
            </Space>
          ) : null}
          {currentUserId ? (
            <Space>
              <Switch checked={onlyMine} onChange={setOnlyMine} disabled={busy} />
              <Typography.Text>Мои</Typography.Text>
            </Space>
          ) : null}
          <Space>
            <Switch checked={multiple} onChange={setMultiple} disabled={busy} />
            <Typography.Text>Несколько поставок</Typography.Text>
          </Space>
        </Space>
        <Table<SourceDocument>
          rowKey="id"
          dataSource={filtered}
          loading={list.isLoading || busy}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          // Скролл внутри tbody — фиксируем высоту с учётом высот шапки
          // модалки, switch'а «все объекты», заголовка таблицы и пагинации.
          // ~240px суммарно при 95vh body, остальное — данные.
          scroll={{ y: 'calc(95vh - 260px)' }}
          onRow={(r) => ({
            onClick: () => {
              if (!busy) onPick(r);
            },
            style: { cursor: busy ? 'progress' : 'pointer' },
          })}
          locale={{
            emptyText: list.isLoading
              ? 'Загрузка…'
              : 'Нет свободных УПД для привязки',
          }}
          columns={[
            {
              title: 'Номер',
              dataIndex: 'docNumber',
              render: (v: string | null) => (
                <Tag color="blue">{v ?? '— без номера —'}</Tag>
              ),
            },
            {
              title: 'Дата',
              dataIndex: 'docDate',
              render: (v: string | null) => v ?? '—',
            },
            {
              title: 'Поставщик',
              key: 'supplier',
              render: (_: unknown, r: SourceDocument) => r.supplierName ?? '—',
            },
            {
              title: 'Подрядчик',
              key: 'contractor',
              render: (_: unknown, r: SourceDocument) => r.contractorName ?? '—',
            },
            {
              title: 'Объект',
              key: 'site',
              render: (_: unknown, r: SourceDocument) => r.siteName ?? '—',
            },
            {
              title: 'Сумма',
              key: 'total',
              render: (_: unknown, r: SourceDocument) =>
                r.totalSum ? `${r.totalSum} ₽` : '—',
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
