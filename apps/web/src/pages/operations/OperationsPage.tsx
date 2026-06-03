import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Space, Switch, Tabs, Typography, message } from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import type { SourceDocument } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { api, apiDownload } from '../../services/api';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { ExpectedUpds } from '../kpp/ExpectedUpds';
import { ExpectedOutbound } from '../shipments/ExpectedOutbound';
import { DeliveriesHistory } from '../kpp/DeliveriesHistory';
import { ShipmentsHistory } from '../shipments/ShipmentsHistory';

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

  // Создание новой записи — переход на старую edit-страницу с new=1.
  // На втором этапе тут будет открываться модалка вместо перехода.
  const createNew = () => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&new=1`);
    else navigate(`/shipments?shipment=${id}&new=1`);
  };
  const createFromUpd = (upd: SourceDocument) => {
    if (inspectorWithoutSite) {
      message.error('Объект не назначен — обратитесь к администратору');
      return;
    }
    const id = crypto.randomUUID();
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&new=1&upd=${upd.id}`);
    else navigate(`/shipments?shipment=${id}&new=1&upd=${upd.id}`);
  };
  const onOpenExisting = (id: string) => {
    if (type === 'delivery') navigate(`/kpp?delivery=${id}&from=accepted`);
    else navigate(`/shipments?shipment=${id}&from=accepted`);
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
            {/* Под ним — обычные табы Ожидаемые/Принятые. */}
            <PageTabs
              items={listTabs}
              activeKey={tab}
              onChange={(k) => updateUrl({ tab: k })}
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
    </StickyPageHeader>
  );
}
