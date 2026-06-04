import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Modal, Space, Spin, Switch, Tabs, Tag, Typography, message } from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import type { SourceDocument } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, apiDownload } from '../../services/api';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { useOperationsCounters } from '../../shared/hooks/useOperationsCounters';
import { ExpectedUpds } from '../kpp/ExpectedUpds';
import { ExpectedOutbound } from '../shipments/ExpectedOutbound';
import { DeliveriesHistory } from '../kpp/DeliveriesHistory';
import { ShipmentsHistory } from '../shipments/ShipmentsHistory';

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
const MODAL_DISABLED =
  import.meta.env.VITE_OPERATIONS_MODAL_DISABLED === '1';

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

  const type: OpType = params.get('type') === 'shipment' ? 'shipment' : 'delivery';
  const tab: ListTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';
  const isInspector = authUser?.role === 'inspector_kpp';
  const inspectorWithoutSite = isInspector && !authUser?.siteId;

  const updateUrl = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
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

  // Создание / открытие записи. Для обоих типов (delivery/shipment)
  // открываем модалку прямо здесь — добавляем `?delivery=`/`?shipment=`
  // к текущему URL `/operations`. KppPage/ShipmentPage внутри Modal
  // читают эти параметры из useSearchParams.
  // Под feature flag MODAL_DISABLED — всё через старые страницы.
  const createNew = () => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    if (!MODAL_DISABLED) {
      if (type === 'delivery') updateUrl({ delivery: id, new: '1' });
      else updateUrl({ shipment: id, new: '1' });
      return;
    }
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&new=1`);
    else navigate(`/shipments?shipment=${id}&new=1`);
  };
  const createFromUpd = (upd: SourceDocument) => {
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
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&new=1&upd=${upd.id}`);
    else navigate(`/shipments?shipment=${id}&new=1&upd=${upd.id}&from=list`);
  };
  const onOpenExisting = (id: string) => {
    if (!MODAL_DISABLED) {
      if (type === 'delivery') updateUrl({ delivery: id, from: 'accepted' });
      else updateUrl({ shipment: id, from: 'list' });
      return;
    }
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&from=accepted`);
    else navigate(`/shipments?shipment=${id}&from=list`);
  };

  // Modal'ы открываются по edit-параметрам в URL. После save/cancel
  // внутри KppPage/ShipmentPage navigate сам очищает ?delivery=/
  // ?shipment= — Modal закрывается через open=false.
  const editDeliveryId = type === 'delivery' ? params.get('delivery') : null;
  const editDeliveryIsNew =
    type === 'delivery' && params.get('new') === '1';
  const deliveryModalOpen =
    !MODAL_DISABLED && (Boolean(editDeliveryId) || editDeliveryIsNew);
  const closeDeliveryModal = () => {
    updateUrl({ delivery: null, new: null, upd: null, from: null });
  };
  const editShipmentId = type === 'shipment' ? params.get('shipment') : null;
  const editShipmentIsNew =
    type === 'shipment' && params.get('new') === '1';
  const shipmentModalOpen =
    !MODAL_DISABLED && (Boolean(editShipmentId) || editShipmentIsNew);
  const closeShipmentModal = () => {
    updateUrl({ shipment: null, new: null, upd: null, from: null });
  };

  // Экспорт Excel — повторяет логику KppPage.handleExportExcel, но
  // зависит ещё и от type (выбираем deliveries/shipments endpoint).
  const [exporting, setExporting] = useState(false);
  async function handleExportExcel() {
    try {
      setExporting(true);
      const contractor = params.get('contractor');
      const supplier = params.get('supplier');
      const site = params.get('site');
      const qVal = params.get('q')?.trim();
      const qs = new URLSearchParams();
      if (contractor) qs.set('contractorIds', contractor);
      if (supplier) qs.set('supplierIds', supplier);
      if (site) qs.set('siteIds', site);
      if (qVal) qs.set('q', qVal);
      const today = new Date().toISOString().slice(0, 10);
      let path: string;
      let fallback: string;
      if (tab === 'expected') {
        qs.set('direction', type === 'delivery' ? 'inbound' : 'outbound');
        qs.set('unaccepted', 'true');
        path = `/source-documents/export.xlsx?${qs.toString()}`;
        fallback = `documents-expected-${type}-${today}.xlsx`;
      } else if (type === 'delivery') {
        if (params.get('trash') === '1') qs.set('trash', 'true');
        path = `/deliveries/export.xlsx?${qs.toString()}`;
        fallback = `deliveries-${today}.xlsx`;
      } else {
        // Для отгрузок аналогичного endpoint'а нет — фоллбек на
        // source-documents direction=outbound без unaccepted-фильтра.
        qs.set('direction', 'outbound');
        path = `/source-documents/export.xlsx?${qs.toString()}`;
        fallback = `documents-shipments-${today}.xlsx`;
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _apiSink = api; // keep import used (для будущих RPC из этой страницы)

  const createButton = (
    <Button
      type="primary"
      icon={<PlusOutlined />}
      onClick={createNew}
      disabled={inspectorWithoutSite}
    >
      {type === 'delivery' ? 'Новая приёмка' : 'Новая отгрузка'}
    </Button>
  );
  const exportButton = (
    <Button icon={<DownloadOutlined />} onClick={handleExportExcel} loading={exporting}>
      Экспорт Excel
    </Button>
  );
  const headerExtras = (
    <Space size={8}>
      {createButton}
      {exportButton}
    </Space>
  );

  const listTabs: PageTabItem[] = [
    { key: 'expected', label: 'Ожидаемые' },
    { key: 'accepted', label: 'Принятые' },
  ];

  return (
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
              onChange={(k) => updateUrl({ type: k })}
              items={[
                {
                  key: 'delivery',
                  label: (
                    <span style={{ fontSize: 22, fontWeight: 600 }}>Приёмка</span>
                  ),
                },
                {
                  key: 'shipment',
                  label: (
                    <span style={{ fontSize: 22, fontWeight: 600 }}>Отгрузка</span>
                  ),
                },
              ]}
              style={{ marginBottom: -12 }}
            />
            {/* Под ним — обычные табы Ожидаемые/Принятые. Справа —
                «В процессе: N» (filled + shipped) если есть активные. */}
            <PageTabs
              items={listTabs}
              activeKey={tab}
              onChange={(k) => updateUrl({ tab: k })}
              extra={
                counters.data && counters.data.inProgress > 0 ? (
                  <Tag color="green" style={{ marginInlineEnd: 0 }}>
                    В процессе: {counters.data.inProgress}
                  </Tag>
                ) : null
              }
            />
          </div>
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
      }
    >
      {tab === 'expected' ? (
        type === 'delivery' ? (
          <ExpectedUpds onOpen={createFromUpd} filtersExtra={headerExtras} />
        ) : (
          <ExpectedOutbound onOpen={createFromUpd} filtersExtra={headerExtras} />
        )
      ) : type === 'delivery' ? (
        <DeliveriesHistory onOpen={onOpenExisting} filtersExtra={headerExtras} />
      ) : (
        <ShipmentsHistory onOpen={onOpenExisting} filtersExtra={headerExtras} />
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
        title={editDeliveryIsNew ? 'Новая приёмка' : 'Приёмка'}
        width="95vw"
        style={{ top: 12, paddingBottom: 0, maxWidth: 'none' }}
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
        keyboard={false}
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
        title={editShipmentIsNew ? 'Новая отгрузка' : 'Отгрузка'}
        width="95vw"
        style={{ top: 12, paddingBottom: 0, maxWidth: 'none' }}
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
        keyboard={false}
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
  );
}
