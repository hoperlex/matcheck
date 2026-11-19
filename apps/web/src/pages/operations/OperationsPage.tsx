import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Dropdown,
  Modal,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DownOutlined, DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Delivery, PageId, Shipment, SourceDocument } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { api, apiDownload } from '../../services/api';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { useOperationsCounters } from '../../shared/hooks/useOperationsCounters';
import { ExpectedUpds } from '../kpp/ExpectedUpds';
import { ExpectedOutbound } from '../shipments/ExpectedOutbound';
import { DeliveriesHistory } from '../kpp/DeliveriesHistory';
import { ShipmentsHistory } from '../shipments/ShipmentsHistory';
import { operationsListQuery, readOperationsFilters } from './operationsQuery';
import { applyOperationsTabMemory, pageUrl } from '../../shared/listMemory';

// KppPage и ShipmentPage — крупные модули с собственными зависимостями
// (IndexedDB, photoPipeline). Грузим лениво — модалка не появится без
// клика, не тратим бандл-стартап на их разбор.
const KppPage = lazy(() => import('../kpp/KppPage'));
const ShipmentPage = lazy(() => import('../shipments/ShipmentPage'));

/**
 * Feature flag: если выставлен `VITE_OPERATIONS_MODAL_DISABLED=1`, edit
 * остаётся на старой полной странице `/kpp?delivery=…`. Страховка на
 * случай регрессий в Modal-обвязке: можно мгновенно вернуть прежнее
 * поведение без revert'а коммита.
 */
const MODAL_DISABLED = import.meta.env.VITE_OPERATIONS_MODAL_DISABLED === '1';

type OpType = 'delivery' | 'shipment';
type ListTab = 'expected' | 'accepted';

/**
 * Объединённый раздел «Операции» — заменил отдельные разделы Приёмка
 * и Отгрузка. В URL ?type=delivery|shipment и ?tab=expected|accepted.
 *
 * Списочный режим живёт здесь. Редактирование (форма приёмки/отгрузки)
 * пока остаётся на старых маршрутах /kpp?delivery=... и
 * /shipments?shipment=... — клик по строке навигирует туда. На втором
 * этапе edit-режим переедет в большую модалку поверх этой страницы;
 * пока что трогать его рискованно (IndexedDB-кэш фото, mutations).
 *
 * Старые URL /kpp и /shipments без edit-параметров делают редирект
 * на /operations через гарды в router.tsx — старые закладки работают.
 */
export default function OperationsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const authUser = useAuthStore((s) => s.user);
  const counters = useOperationsCounters();

  const requestedType: OpType = params.get('type') === 'shipment' ? 'shipment' : 'delivery';
  const { can, canView } = usePermissions();
  const canSeeDeliveries = canView('operations.deliveries');
  const canSeeShipments = canView('operations.shipments');
  // Закрытую вкладку не показываем и не открываем: подменённый вручную
  // ?type= молча приземляется на доступную половину, а не в отказ.
  const type: OpType =
    requestedType === 'shipment'
      ? canSeeShipments
        ? 'shipment'
        : 'delivery'
      : canSeeDeliveries
        ? 'delivery'
        : 'shipment';
  const page: PageId = type === 'delivery' ? 'operations.deliveries' : 'operations.shipments';
  const canCreate = can(page, 'create');
  const canEditOps = can(page, 'edit');
  const tab: ListTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';
  const isInspector = authUser?.role === 'inspector_kpp';
  const isContractor = authUser?.role === 'contractor';
  const inspectorWithoutSite = isInspector && !authUser?.siteId;
  // Подрядчик без привязки к контрагенту видит пустые списки — показываем баннер.
  const contractorWithoutLink = isContractor && !authUser?.contractorCustomerId;

  const updateUrl = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  // При смене type (Приёмка/Отгрузка) или tab (Ожидаемые/Принятые) снимаем всё,
  // что относилось к прежнему разделу.
  //
  // Кроме страницы это ещё и параметры, чьи значения у приёмок и отгрузок
  // разные: коды статусов не пересекаются (`filled` против `shipped`), и
  // перенесённый ?status= отбивался валидацией — вместо таблицы человек видел
  // красный Alert. Короткие id — свои последовательности, назначение есть
  // только у отгрузок, а delivery/shipment/new/upd/from открывали карточку
  // чужого раздела при возврате.
  //
  // Страница, статус, id и назначение при этом не теряются: у каждой вкладки
  // они свои и возвращаются из памяти списков (shared/listMemory), когда
  // человек приходит на вкладку обратно. Период, объект и признаки — общие.
  const updateUrlResetPage = (patch: { type?: string; tab?: string }) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
    }
    for (const key of ['delivery', 'shipment', 'new', 'manual', 'upd', 'from']) next.delete(key);
    applyOperationsTabMemory(next, {
      type: next.get('type') === 'shipment' ? 'shipment' : 'delivery',
      tab: next.get('tab') === 'accepted' ? 'accepted' : 'expected',
    });
    // Одним setParams: два вызова за такт затёрли бы друг друга.
    setParams(next, { replace: true });
  };

  // В режиме отдельной страницы редактору тоже нужен URL текущего списка:
  // после сохранения он вернёт пользователя на тот же page с теми же фильтрами.
  const legacyEditorUrl = (path: '/kpp' | '/shipments', patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return `${path}?${next.toString()}`;
  };

  const trashOn = params.get('trash') === '1';
  const isAdminUser = authUser?.role === 'admin';
  const trashSwitchVisible = tab === 'accepted' && isAdminUser;
  const setTrash = (next: boolean) => {
    if (next) updateUrl({ trash: '1', tab: 'accepted' });
    else updateUrl({ trash: null });
  };
  // Manager не должен видеть удалённые приёмки/отгрузки. Если кто-то
  // введёт ?trash=1 в URL руками — сбрасываем параметр.
  useEffect(() => {
    if (!isAdminUser && trashOn) updateUrl({ trash: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminUser, trashOn]);

  // ?type= указывает на закрытую половину — приводим URL к тому, что человек
  // реально видит. Именно updateUrl, а не редирект: страница остаётся та же,
  // а адрес перестаёт врать (и корректно ложится в закладки).
  useEffect(() => {
    if (requestedType !== type) updateUrlResetPage({ type });
    // updateUrlResetPage намеренно вне зависимостей: он пересоздаётся каждым
    // рендером и добавил бы лишние срабатывания, а нужен нам только факт
    // расхождения запрошенного и доступного типа.
  }, [requestedType, type]);

  // Создание / открытие записи. Для обоих типов (delivery/shipment)
  // открываем модалку прямо здесь — добавляем `?delivery=`/`?shipment=`
  // к текущему URL `/operations`. KppPage/ShipmentPage внутри Modal
  // читают эти параметры из useSearchParams.
  // Под feature flag MODAL_DISABLED — всё через старые страницы.
  // manual — «Ручной внос/вынос»: без машины одним этапом (?manual=1 читает
  // KppPage / ShipmentPage). Имя параметра не совпадает с фильтром списка
  // (`entry`), иначе закрытие формы стирало бы фильтр.
  const createNew = (manual = false) => {
    // Кнопка при закрытом «Создавать» не рисуется вовсе; проверка здесь — на
    // случай вызова из другого места (горячая клавиша, старая ссылка).
    if (!canCreate) {
      message.error('Недостаточно прав для создания');
      return;
    }
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    const manualParam = manual ? '1' : null;
    if (!MODAL_DISABLED) {
      if (type === 'delivery') updateUrl({ delivery: id, new: '1', manual: manualParam });
      else updateUrl({ shipment: id, new: '1', manual: manualParam });
      return;
    }
    if (type === 'delivery')
      navigate(legacyEditorUrl('/kpp', { delivery: id, new: '1', manual: manualParam }));
    else navigate(legacyEditorUrl('/shipments', { shipment: id, new: '1', manual: manualParam }));
  };
  const createFromUpd = (upd: SourceDocument) => {
    if (!canCreate) {
      message.error('Недостаточно прав для создания');
      return;
    }
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    if (!MODAL_DISABLED) {
      if (type === 'delivery') updateUrl({ delivery: id, new: '1', upd: upd.id });
      else updateUrl({ shipment: id, new: '1', upd: upd.id, from: 'list' });
      return;
    }
    if (type === 'delivery')
      navigate(legacyEditorUrl('/kpp', { delivery: id, new: '1', upd: upd.id }));
    else
      navigate(
        legacyEditorUrl('/shipments', { shipment: id, new: '1', upd: upd.id, from: 'list' }),
      );
  };
  const onOpenExisting = (id: string) => {
    if (!MODAL_DISABLED) {
      if (type === 'delivery') updateUrl({ delivery: id, from: 'accepted' });
      else updateUrl({ shipment: id, from: 'list' });
      return;
    }
    if (type === 'delivery') navigate(legacyEditorUrl('/kpp', { delivery: id, from: 'accepted' }));
    else navigate(legacyEditorUrl('/shipments', { shipment: id, from: 'list' }));
  };

  // Modal'ы открываются по edit-параметрам в URL. После save/cancel
  // внутри KppPage/ShipmentPage navigate сам очищает ?delivery=/
  // ?shipment= — Modal закрывается через open=false.
  const editDeliveryId = type === 'delivery' ? params.get('delivery') : null;
  const editDeliveryIsNew = type === 'delivery' && params.get('new') === '1';
  const editShipmentId = type === 'shipment' ? params.get('shipment') : null;
  const editShipmentIsNew = type === 'shipment' && params.get('new') === '1';

  // URL — единственный источник правды для open. Раньше параллельно
  // существовал локальный флаг closing (и afterClose как точка очистки
  // URL). Из-за двух источников при закрытии возникало мигание:
  //   1) onCancel ставил closing=true → modalOpen=false → Modal закрылся;
  //   2) afterClose выполнял setClosing(false) ДО того, как updateUrl
  //      успел применить новый params → ?delivery= ещё в URL →
  //      editDeliveryId truthy И closing уже false → modalOpen снова
  //      true на один кадр → модалка мигала.
  // Защита «слепка таблицы» (ради которой когда-то ввели closing) теперь
  // не нужна — `if (embedded) return null;` в KppPage / ShipmentPage
  // перехватывает любой рендер этих компонентов без params.
  // Редактор открывается по ПРАВУ, а не по имени роли: администратор может
  // выдать роли создание или правку во вкладке «Роли», и форма обязана
  // открыться. Права разные: новая запись требует «Создавать», существующая —
  // «Редактировать». Иначе роль с одним лишь create открывала бы чужую приёмку
  // и получала 403 при сохранении. Без права остаётся модалка просмотра (клик
  // по строке / «глаз») с отметкой проверки; сервер запрет дублирует.
  const deliveryModalOpen =
    !MODAL_DISABLED && (editDeliveryIsNew ? canCreate : Boolean(editDeliveryId) && canEditOps);
  const shipmentModalOpen =
    !MODAL_DISABLED && (editShipmentIsNew ? canCreate : Boolean(editShipmentId) && canEditOps);

  // Закрытие — один проход: чистим URL (или уходим на /materials, если
  // пришли оттуда). Modal видит open=false на следующем рендере и
  // закрывается. Никакого closing/afterClose — нет места, где модалка
  // могла бы «вернуться» на кадр.
  //
  // В Историю — с её фильтрами (shared/listMemory) и replace: «Назад»
  // браузера после закрытия не должен снова открывать карточку.
  const closeDeliveryModal = () => {
    if (params.get('from') === 'materials') {
      navigate(pageUrl('/materials'), { replace: true });
      return;
    }
    updateUrl({ delivery: null, new: null, manual: null, upd: null, from: null });
  };
  const closeShipmentModal = () => {
    if (params.get('from') === 'materials') {
      navigate(pageUrl('/materials'), { replace: true });
      return;
    }
    updateUrl({ shipment: null, new: null, manual: null, upd: null, from: null });
  };

  // Подтягиваем displayId для заголовков модалок «Приёмка #N» / «Отгрузка #N».
  // Используем тот же queryKey, что и KppPage/ShipmentPage — react-query
  // делит кэш, дополнительного запроса к серверу не делает (после того, как
  // соответствующая страница уже загружена).
  const deliveryHeader = useQuery({
    queryKey: ['deliveries', editDeliveryId],
    queryFn: () => api.get<Delivery>(`/deliveries/${editDeliveryId}`),
    enabled: deliveryModalOpen && !!editDeliveryId,
    staleTime: 30_000,
  });
  const shipmentHeader = useQuery({
    queryKey: ['shipments', editShipmentId],
    queryFn: () => api.get<Shipment>(`/shipments/${editShipmentId}`),
    enabled: shipmentModalOpen && !!editShipmentId,
    staleTime: 30_000,
  });

  // Экспорт Excel — повторяет логику KppPage.handleExportExcel, но
  // зависит ещё и от type (выбираем deliveries/shipments endpoint).
  const [exporting, setExporting] = useState(false);
  async function handleExportExcel() {
    try {
      setExporting(true);
      const today = new Date().toISOString().slice(0, 10);
      let path: string;
      let fallback: string;
      if (tab === 'expected') {
        // «Ожидаемые» — документы, у них свой набор фильтров без периода.
        const qs = new URLSearchParams();
        const contractor = params.get('contractor');
        const supplier = params.get('supplier');
        const site = params.get('site');
        const qVal = params.get('q')?.trim();
        if (contractor) qs.set('contractorIds', contractor);
        if (supplier) qs.set('supplierIds', supplier);
        if (site) qs.set('siteIds', site);
        if (qVal) qs.set('q', qVal);
        qs.set('direction', type === 'delivery' ? 'inbound' : 'outbound');
        qs.set('unaccepted', 'true');
        // Тот же набор типов, что показывает таблица: без него в файл
        // попадали ещё и заявки, которых на экране нет.
        qs.set('kind', 'upd,transport_waybill,os2_transfer');
        path = `/source-documents/export.xlsx?${qs.toString()}`;
        fallback = `documents-expected-${type}-${today}.xlsx`;
      } else {
        // Приёмки и отгрузки выгружаются своими маршрутами и тем же набором
        // фильтров, что уходит в таблицу. Раньше у отгрузок собственного
        // экспорта не было: страница отдавала ИСХОДЯЩИЕ документы, которых в
        // базе один за всё время, — пользователь получал пустой лист.
        const qs = operationsListQuery(readOperationsFilters(params), {
          kind: type === 'delivery' ? 'delivery' : 'shipment',
          trash: params.get('trash') === '1',
        });
        path =
          type === 'delivery'
            ? `/deliveries/export.xlsx?${qs.toString()}`
            : `/shipments/export.xlsx?${qs.toString()}`;
        fallback = type === 'delivery' ? `deliveries-${today}.xlsx` : `shipments-${today}.xlsx`;
      }
      const { blob, filename } = await apiDownload(path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || fallback;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  // Две формы: с машиной (1 и 2 этап) и ручной внос/вынос — один этап, как
  // одноимённая форма на планшете.
  const createButton = (
    <Dropdown
      trigger={['click']}
      disabled={inspectorWithoutSite}
      menu={{
        items: [
          {
            key: 'vehicle',
            label: type === 'delivery' ? 'Приёмка с машиной' : 'Отгрузка с машиной',
          },
          {
            key: 'manual',
            label: type === 'delivery' ? 'Ручной внос (1 этап)' : 'Ручной вынос (1 этап)',
          },
        ],
        onClick: ({ key }) => createNew(key === 'manual'),
      }}
    >
      <Button type="primary" icon={<PlusOutlined />} disabled={inspectorWithoutSite}>
        {type === 'delivery' ? 'Новая приёмка' : 'Новая отгрузка'} <DownOutlined />
      </Button>
    </Dropdown>
  );
  const exportButton = (
    <Button icon={<DownloadOutlined />} onClick={handleExportExcel} loading={exporting}>
      Экспорт Excel
    </Button>
  );
  const headerExtras = (
    <Space size={8}>
      {/* Только по матрице: перечислять роли рядом с правом незачем — у
          read-only ролей create в дефолте нет, а выданный админом обязан
          показать кнопку. Сервер проверку дублирует отказом. */}
      {canCreate && createButton}
      {exportButton}
    </Space>
  );

  const listTabs: PageTabItem[] = [
    { key: 'expected', label: 'Ожидаемые' },
    { key: 'accepted', label: 'Принятые' },
  ];

  return (
    <>
      {/* Стили подсветки строк в журнале «Принятые»: жёлтый — filled/
          shipped без МОЛ за сегодня; красный — то же со вчера и старше.
          Hover-цвета — чуть темнее основной заливки, чтобы оставалось
          ощущение интерактивности (rowClassName может комбинироваться
          с antd hover-стилями). !important — antd row-hover сильнее. */}
      <style>{`
        .${'matcheck-row-progress-today'} > td { background-color: #fffbe6 !important; }
        .${'matcheck-row-progress-today'}:hover > td { background-color: #fff1b8 !important; }
        .${'matcheck-row-overdue'} > td { background-color: #fff1f0 !important; }
        .${'matcheck-row-overdue'}:hover > td { background-color: #ffccc7 !important; }
      `}</style>
      <StickyPageHeader
        header={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              width: '100%',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 40, flexWrap: 'wrap' }}>
              {/* Верхний переключатель — между Приёмкой и Отгрузкой. Крупный
                жирный шрифт делает табы похожими на заголовок раздела
                (заменяет Typography.Title). gap:40 на родителе создаёт
                визуальный разрыв с подчинёнными табами «Ожидаемые/Принятые». */}
              <Tabs
                size="large"
                activeKey={type}
                onChange={(k) => updateUrlResetPage({ type: k })}
                items={[
                  ...(canSeeDeliveries
                    ? [
                        {
                          key: 'delivery',
                          label: <span style={{ fontSize: 22, fontWeight: 600 }}>Приёмка</span>,
                        },
                      ]
                    : []),
                  ...(canSeeShipments
                    ? [
                        {
                          key: 'shipment',
                          label: <span style={{ fontSize: 22, fontWeight: 600 }}>Отгрузка</span>,
                        },
                      ]
                    : []),
                ]}
                style={{ marginBottom: -12 }}
              />
              {/* Под ним — обычные табы Ожидаемые/Принятые. Справа —
                «Сегодня в процессе: N» (жёлтый) и «Незавершенные: N»
                (красный) — оба показываются только если есть строки.
                «Сегодня в процессе» = filled/shipped без МОЛ за сегодня;
                «Незавершенные» = filled/shipped без МОЛ со вчера и раньше. */}
              <PageTabs
                items={listTabs}
                activeKey={tab}
                onChange={(k) => updateUrlResetPage({ tab: k })}
                extra={
                  counters.data &&
                  (counters.data.inProgressToday > 0 || counters.data.overdue > 0) ? (
                    <Space size={8} style={{ marginLeft: 40 }}>
                      {counters.data.inProgressToday > 0 && (
                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                          Сегодня в процессе: {counters.data.inProgressToday}
                        </Tag>
                      )}
                      {counters.data.overdue > 0 && (
                        <Tooltip title="Незавершенные за другие дни">
                          <Tag color="red" style={{ marginInlineEnd: 0, cursor: 'help' }}>
                            Незавершенные: {counters.data.overdue}
                          </Tag>
                        </Tooltip>
                      )}
                    </Space>
                  ) : null
                }
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* Массовые действия «Выбрано: N | …» здесь больше не живут:
                рядом с переключателем они не помещались, шапка переносилась
                второй строкой и опускала таблицу. Теперь они встают на место
                «Обозначений» над таблицей (LegendOrBulkBar). */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  visibility: trashSwitchVisible ? 'visible' : 'hidden',
                }}
              >
                <Switch checked={trashOn} onChange={setTrash} />
                <Typography.Text type={trashOn ? undefined : 'secondary'}>
                  Удалённые
                </Typography.Text>
              </div>
            </div>
          </div>
        }
      >
        {contractorWithoutLink && (
          <Alert
            type="warning"
            showIcon
            message="Подрядчик не назначен — обратитесь к администратору."
            style={{ marginBottom: 12 }}
          />
        )}
        {tab === 'expected' ? (
          type === 'delivery' ? (
            <ExpectedUpds onOpen={createFromUpd} filtersExtra={headerExtras} />
          ) : (
            <ExpectedOutbound onOpen={createFromUpd} filtersExtra={headerExtras} />
          )
        ) : type === 'delivery' ? (
          <DeliveriesHistory
            onOpen={onOpenExisting}
            filtersExtra={headerExtras}
            // Группы приёмок (рейсы одной поставки) — только здесь, в «Принятых».
            showGroups
          />
        ) : (
          <ShipmentsHistory
            onOpen={onOpenExisting}
            filtersExtra={headerExtras}
          />
        )}

        {/* Модалка edit-режима Приёмки (этап А). KppPage внутри получает
          deliveryId/new=1 из тех же URL-параметров, что и раньше — никаких
          изменений в его внутренней логике. key={editDeliveryId ?? 'new'}
          + destroyOnClose дают полный unmount/remount при смене записи —
          IndexedDB-photo-pipeline корректно пересоздаётся.
          В этапе А мутации внутри KppPage всё ещё навигируют на
          /kpp?tab=accepted; KppGuard перенаправит обратно на /operations,
          и Modal закроется через open=false (промежуточный мерцающий
          /kpp устранит этап Б). */}
        <Modal
          open={deliveryModalOpen}
          onCancel={closeDeliveryModal}
          title={
            editDeliveryIsNew
              ? params.get('manual') === '1'
                ? 'Ручной внос'
                : 'Новая приёмка'
              : deliveryHeader.data
                ? `Приёмка ${deliveryHeader.data.displayId}`
                : 'Приёмка'
          }
          width="95vw"
          style={{ maxWidth: 'none' }}
          styles={{
            // Body высоты 95vh минус заголовок (~50) и небольшие отступы.
            // Скролл идёт внутри body — фиксированный header и footer (если
            // были бы) остаются на местах.
            body: {
              padding: '12px 16px',
              maxHeight: 'calc(95vh - 56px)',
              overflowY: 'auto',
            },
          }}
          footer={null}
          destroyOnClose
          maskClosable={false}
          // ESC закрывает модалку через тот же onCancel, что и крестик.
          keyboard
          // Отключаем zoom-leave + mask-fade-leave анимации. Причина:
          // высота body 95vh, и в середине zoom-out (~100мс) центр уже
          // схлопнулся, а верх ещё виден — пользователь видит белую
          // горизонтальную полосу с title+крестиком. С transitionName=""
          // и maskTransitionName="" модалка пропадает мгновенно: нет
          // промежуточных кадров — нет артефакта. afterClose продолжает
          // вызываться (он не привязан к длительности анимации). Enter
          // тоже становится мгновенным — для full-screen modal это
          // воспринимается как ожидаемое поведение «открылась/закрылась».
          transitionName=""
          maskTransitionName=""
        >
          <Suspense
            fallback={
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                <Spin size="large" />
              </div>
            }
          >
            <KppPage key={editDeliveryId ?? 'new'} embedded />
          </Suspense>
        </Modal>

        {/* Модалка edit-режима Отгрузки (этап В). По смыслу симметрична
          Приёмке: открывается при ?shipment=… или (?new=1 && type=shipment),
          ShipmentPage внутри сам читает useSearchParams. key + destroyOnClose
          гарантируют полный unmount/remount при смене записи — IndexedDB
          photo-pipeline `['photos-local','shipment',shipmentId]` пересоздаётся. */}
        <Modal
          open={shipmentModalOpen}
          onCancel={closeShipmentModal}
          title={
            editShipmentIsNew
              ? params.get('manual') === '1'
                ? 'Ручной вынос'
                : 'Новая отгрузка'
              : shipmentHeader.data
                ? `Отгрузка ${shipmentHeader.data.displayId}`
                : 'Отгрузка'
          }
          width="95vw"
          style={{ maxWidth: 'none' }}
          styles={{
            // Body высоты 95vh минус заголовок (~50) и небольшие отступы.
            // Скролл идёт внутри body — фиксированный header и footer (если
            // были бы) остаются на местах.
            body: {
              padding: '12px 16px',
              maxHeight: 'calc(95vh - 56px)',
              overflowY: 'auto',
            },
          }}
          footer={null}
          destroyOnClose
          maskClosable={false}
          // ESC закрывает модалку через тот же onCancel, что и крестик.
          keyboard
          // См. комментарий у Modal приёмки выше — отключаем zoom-leave
          // и mask-fade-leave, чтобы убрать промежуточный кадр с белой
          // полосой title+крестика при закрытии full-screen модалки.
          transitionName=""
          maskTransitionName=""
        >
          <Suspense
            fallback={
              <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                <Spin size="large" />
              </div>
            }
          >
            <ShipmentPage key={editShipmentId ?? 'new'} embedded />
          </Suspense>
        </Modal>
      </StickyPageHeader>
    </>
  );
}
