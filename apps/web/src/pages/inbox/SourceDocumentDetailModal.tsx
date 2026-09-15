import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Collapse,
  ConfigProvider,
  DatePicker,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Splitter,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SourceDirection,
  SourceDocumentDetail,
  SourceDocumentFileResponse,
  SourceRecoverResponse,
  SourceReparseResponse,
  UpdCheck,
  UpdWarning,
} from '@matcheck/contracts';
import { getDocumentDisplayStatus } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { api, ApiError } from '../../services/api';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import {
  formatDateRu,
  formatMoneyRu,
  inputNumberFormatterRu,
  inputNumberParserRu,
} from '../../shared/utils/formatRu';
import { priceWithVat, priceWithoutVat } from '../../shared/utils/priceWithVat';
import { ExtraFilesFooterButton } from './ExtraFilesBlock';
import { LlmCallsDrawer } from './LlmCallsDrawer';
import { CustomerCounterpartySelect } from './CustomerCounterpartySelect';
import { UnitSelect } from '../../shared/ui/UnitSelect';
import { UpdValidationSummary } from '../../shared/ui/UpdValidationSummary';
import { SiteSelect } from './SiteSelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';
import { DocumentOriginalViewer } from '../shared/DocumentOriginalViewer';
import { SourceDocumentItemsTable } from '../shared/SourceDocumentItemsTable';

type Item = SourceDocumentDetail['items'][number];

type EditItem = {
  nameRaw: string;
  qty: string;
  unit: string;
  /**
   * Цена БЕЗ налога — ровно как в графе 4 бланка и как хранится в базе.
   *
   * В поле ввода показывается цена С налогом, но здесь она остаётся исходной:
   * пересчёт применяется только к тому, что человек реально ввёл. Прогонять
   * весь список через пересчёт при сохранении нельзя — пара преобразований
   * расходится примерно у одной позиции из тысячи, и мы тихо правили бы цены,
   * которых никто не касался.
   */
  price: string | null;
  sum: string | null;
  /**
   * Ставка строки. Раньше терялась при переходе в форму, из-за чего сохранение
   * карточки обнуляло НДС у позиций (см. onSave и серверный PATCH).
   */
  vatRate: string | null;
  /**
   * Цена С НАЛОГОМ — единственное, что правит человек в колонке цены.
   *
   * Отдельное поле состояния, а не производная от `price` на каждый рендер.
   * У antd InputNumber с formatter текст поля перезаписывается из value при
   * любом изменении, включая момент набора: пересчёт на лету заставлял бы
   * цифры прыгать под курсором. И blur без единой правки вызывает onChange —
   * с производным значением это молча переписывало бы цену.
   */
  priceGross: number | null;
};

type EditForm = {
  docNumber: string | null;
  docDate: Dayjs | null;
  expectedDate: Dayjs | null;
  // Только outbound: там получатель обязателен и выбирается вручную —
  // внешний контрагент ЛИБО наш МОЛ. У inbound переключателя нет вовсе
  // (см. RecipientBlock): подрядчик из карточки не выбирается.
  recipientKind: 'counterparty' | 'mol';
  // outbound: внешний контрагент-получатель, которого ждёт mobile при finalize
  // Stage1 «Выезд». У inbound не используется.
  recipientId: string | null;
  recipientMolId: string | null;
  siteId: string | null;
  totalSum: string | null;
  items: EditItem[];
  /**
   * Шапка НА МОМЕНТ ОТКРЫТИЯ карточки — источник ставки для строк, где своя не
   * распозналась. Заморожена намеренно: `totalSum` в форме редактируется, и
   * пересчёт от него дёргал бы цены во всех строках прямо во время набора
   * итога.
   *
   * `null` — документ не УПД: цена показывается и сохраняется как есть.
   */
  vatSource: { totalSum: string | null; vatSum: string | null } | null;
};

function directionLabel(d: SourceDirection): string {
  return d === 'inbound' ? 'Приёмка' : 'Отгрузка';
}

function itemToEdit(i: Item, vatSource: EditForm['vatSource']): EditItem {
  const gross = vatSource
    ? priceWithVat(i.price, i.vatRate, vatSource.totalSum, vatSource.vatSum)
    : i.price;
  return {
    nameRaw: i.nameRaw,
    qty: i.qty,
    unit: i.unit,
    price: i.price,
    sum: i.sum,
    vatRate: i.vatRate,
    priceGross: gross != null && gross !== '' ? Number(gross) : null,
  };
}

/**
 * Цена, которая уйдёт на сервер.
 *
 * Обратный пересчёт применяется ТОЛЬКО к реально изменённому значению. Строку,
 * которую человек не трогал, отправляем ровно тем числом, что пришло из базы:
 * пара пересчётов расходится примерно у одной позиции из тысячи, и прогон
 * всего списка означал бы тихую правку цен, которых никто не касался.
 *
 * Порог в половину копейки — потому что меньше в поле и не ввести: formatter
 * показывает два знака, и antd на blur сплющивает ввод до них. Без порога
 * простой клик в поле и мимо переписывал бы цену с четырьмя знаками на
 * двузначную.
 */
function priceForSave(it: EditItem, vatSource: EditForm['vatSource']): string | null {
  if (it.priceGross == null) return null;
  if (!vatSource) return String(it.priceGross);

  const pristine = priceWithVat(it.price, it.vatRate, vatSource.totalSum, vatSource.vatSum);
  if (pristine != null && Math.abs(it.priceGross - Number(pristine)) < 0.005) {
    return it.price;
  }
  return priceWithoutVat(it.priceGross, it.vatRate, vatSource.totalSum, vatSource.vatSum);
}

// Сплит-режим модалки: 'stacked' — позиции сверху, оригинал снизу (горизонтальный
// разделитель); 'sideBySide' — позиции слева, оригинал справа (вертикальный). В
// antd Splitter ориентация инвертирована: layout='vertical' = панели стек-ом,
// layout='horizontal' = панели рядом.
type SplitMode = 'stacked' | 'sideBySide';
const LAYOUT_LS_KEY = 'matcheck.docModal.layout';

function readLayout(): SplitMode {
  if (typeof window === 'undefined') return 'stacked';
  const v = window.localStorage.getItem(LAYOUT_LS_KEY);
  return v === 'sideBySide' ? 'sideBySide' : 'stacked';
}

// Порог 1280px подобран под минимально читаемый PDF в правой/нижней панели.
// Ниже — split-layout схлопывается до старых вкладок (Позиции/Шапка/Оригинал).
function useIsWideViewport(): boolean {
  const [wide, setWide] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= 1280,
  );
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1280);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}

/**
 * Текст ошибки сохранения карточки.
 *
 * Отказы переноса объекта сервер отдаёт кодом, и показывать менеджеру сырой
 * `machine_has_operation` бессмысленно: ему нужно знать, что делать.
 */
function patchErrorText(err: Error): string {
  if (err instanceof ApiError) {
    if (err.code === 'machine_has_operation') {
      return 'По этой поставке уже оформлена приёмка или отгрузка — объект менять нельзя. Сначала отвяжите документы от операции.';
    }
    if (err.code === 'bundle_exists_on_site') {
      return 'На выбранном объекте этот комплект документов уже загружен — переносить некуда.';
    }
  }
  return err.message;
}

function initialForm(sd: SourceDocumentDetail): EditForm {
  return {
    docNumber: sd.docNumber,
    docDate: sd.docDate ? dayjs(sd.docDate) : null,
    expectedDate: sd.expectedDate ? dayjs(sd.expectedDate) : null,
    // Если у документа сохранён МОЛ — открываем переключатель в его сторону,
    // иначе по умолчанию — контрагент (только outbound).
    recipientKind: sd.recipientMolId ? 'mol' : 'counterparty',
    recipientId: sd.recipientId,
    recipientMolId: sd.recipientMolId,
    siteId: sd.siteId,
    totalSum: sd.totalSum,
    // Единственный гейт «только УПД» в режиме редактирования: у накладных и
    // ОС-2 источника ставки нет, и весь путь вырождается в прежнее поведение.
    vatSource: sd.kind === 'upd' ? { totalSum: sd.totalSum, vatSum: sd.vatSum } : null,
    items: sd.items.map((i) =>
      itemToEdit(i, sd.kind === 'upd' ? { totalSum: sd.totalSum, vatSum: sd.vatSum } : null),
    ),
  };
}

export function SourceDocumentDetailModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role ?? null);
  const { can } = usePermissions();
  const canReparse = can('documents.list', 'reparse');
  const [edit, setEdit] = useState<EditForm | null>(null);
  const [llmDrawerOpen, setLlmDrawerOpen] = useState(false);
  const isWide = useIsWideViewport();
  const [layout, setLayoutState] = useState<SplitMode>(readLayout);
  const setLayout = (next: SplitMode) => {
    setLayoutState(next);
    try {
      window.localStorage.setItem(LAYOUT_LS_KEY, next);
    } catch {
      // localStorage может быть недоступен (privacy mode) — молча игнорируем.
    }
  };

  const detail = useQuery({
    queryKey: ['source-document', id],
    queryFn: () => api.get<SourceDocumentDetail>(`/source-documents/${id}`),
    enabled: open && !!id,
  });

  const file = useQuery({
    queryKey: ['source-document-file', id],
    queryFn: () => api.get<SourceDocumentFileResponse>(`/source-documents/${id}/file`),
    enabled: open && !!id,
    retry: false,
  });

  const sd = detail.data;
  const items = sd?.items ?? [];
  const isProcessing = sd?.status === 'queued' || sd?.status === 'processing';
  const canRecoverWork =
    isProcessing &&
    (sd?.workHealth === 'missing' || sd?.workHealth === 'terminal' || sd?.workHealth === 'overdue');

  const failedChecks = useMemo<UpdCheck[]>(() => {
    if (!sd?.validation?.checks) return [];
    return sd.validation.checks.filter((c) => !c.ok && !c.skipReason);
  }, [sd]);

  const warnings = useMemo<UpdWarning[]>(() => sd?.validation?.warnings ?? [], [sd]);

  // При смене документа сбрасываем форму. При первом открытии — инициализируем.
  useEffect(() => {
    if (sd) {
      setEdit(initialForm(sd));
    } else {
      setEdit(null);
    }
  }, [sd]);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<SourceDocumentDetail>(`/source-documents/${id}`, body),
    onSuccess: () => {
      message.success('Документ сохранён');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      // Один ключ на карточку, префетч списка и раскрытие «+» в списке.
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
      // Второй кэш того же документа — офлайн-first (IndexedDB, наполняется
      // pullSync): его читают КПП и отгрузка при преднаполнении формы из УПД.
      // Сбрасываем и его, иначе форма подставит доредакционные данные.
      void qc.invalidateQueries({ queryKey: ['source-document-offline', id] });
      // Закрываем модалку — пользователь явно подтвердил изменения и не
      // должен дополнительно жать ×. Крестик/Esc остаются как способ
      // выйти без сохранения.
      onClose();
    },
    onError: (err: Error) => message.error(patchErrorText(err)),
  });

  const ack = useMutation({
    mutationFn: () =>
      api.post<SourceDocumentDetail>(`/source-documents/${id}/acknowledge-mismatch`, {}),
    onSuccess: () => {
      message.success('Расхождение принято');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      // Один ключ на карточку, префетч списка и раскрытие «+» в списке.
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
      // Второй кэш того же документа — офлайн-first (IndexedDB, наполняется
      // pullSync): его читают КПП и отгрузка при преднаполнении формы из УПД.
      // Сбрасываем и его, иначе форма подставит доредакционные данные.
      void qc.invalidateQueries({ queryKey: ['source-document-offline', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Повторное распознавание из карточки: именно здесь пользователь и видит,
  // что распозналось плохо. Исходный файл остаётся, меняются только данные.
  const reparse = useMutation({
    mutationFn: () => api.post<SourceReparseResponse>(`/source-documents/${id}/reparse`, {}),
    onSuccess: () => {
      message.success('Документ отправлен на повторное распознавание');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
      void qc.invalidateQueries({ queryKey: ['source-document-offline', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const recover = useMutation({
    mutationFn: () => api.post<SourceRecoverResponse>(`/source-documents/${id}/recover`, {}),
    onSuccess: (res) => {
      if (res.outcome === 'terminalized') {
        message.warning('Автоматические попытки исчерпаны — документ требует решения');
      } else {
        message.success('Распознавание восстановлено');
      }
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
      void qc.invalidateQueries({ queryKey: ['source-document-offline', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  function onSave() {
    if (!edit) return;
    // Получатель. У ОТГРУЗКИ он обязателен и остаётся взаимоисключающим
    // выбором: внешний контрагент (recipientId) либо наш МОЛ; «противоположное»
    // поле чистим явно, иначе PATCH не сбросит ранее сохранённое.
    //
    // У ПРИЁМКИ подрядчик из карточки больше не выбирается — он не нужен ни
    // «Обработано», ни планшету, где показывается грузополучатель из самого
    // документа. contractorId в тело НЕ кладём вовсе: значение в базе живёт
    // своей жизнью (фильтр «Подрядчик», роль contractor), и затирать его
    // сохранением реквизитов нельзя.
    const isOutbound = sd?.direction === 'outbound';
    const body: Record<string, unknown> = {
      docNumber: edit.docNumber,
      docDate: edit.docDate ? edit.docDate.format('YYYY-MM-DD') : null,
      expectedDate: edit.expectedDate ? edit.expectedDate.format('YYYY-MM-DD') : null,
      recipientMolId: isOutbound
        ? edit.recipientKind === 'mol'
          ? edit.recipientMolId
          : null
        : edit.recipientMolId,
      siteId: edit.siteId,
      totalSum: edit.totalSum,
      items: edit.items.map((it) => ({
        nameRaw: it.nameRaw,
        qty: it.qty,
        unit: it.unit,
        price: priceForSave(it, edit.vatSource),
        sum: it.sum,
        // Ставку отправляем обратно, иначе сервер перезапишет позиции без неё:
        // PATCH заменяет строки целиком, и НДС у документа обнулялся после
        // первой же правки карточки.
        vatRate: it.vatRate,
      })),
    };
    if (isOutbound) {
      // contractorId (наш отправитель) этой формой не правим — оставляем как
      // в БД, не отправляя в PATCH вовсе.
      body.recipientId = edit.recipientKind === 'counterparty' ? edit.recipientId : null;
    }
    patch.mutate(body);
  }

  // Снятие даты поставки у машины: без даты поставка пропадает у инспектора
  // ЦЕЛИКОМ — предикат видимости требует дату у каждого документа рейса, и один
  // пустой гасит остальные. Спрашиваем только в этом случае: подтверждение на
  // каждом сохранении менеджер перестал бы читать.
  const clearsMachineDate =
    !!sd &&
    !!edit &&
    sd.expectedDate != null &&
    edit.expectedDate == null &&
    (sd.portalGroupSize ?? 0) > 1;

  const isMismatchPending =
    sd?.status === 'needs_resolution' && sd.parseErrorCode === 'validation_mismatch';
  const isDuplicate = sd?.status === 'needs_resolution' && sd.parseErrorCode === 'duplicate_upd';

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        maskClosable={false}
        keyboard={false}
        title={
          sd ? (
            <Space size={4} wrap style={{ fontSize: 12 }}>
              <Tag
                style={{ marginInlineEnd: 0 }}
                color={sd.direction === 'inbound' ? 'green' : 'purple'}
              >
                {directionLabel(sd.direction)}
              </Tag>
              {(() => {
                // Чип статуса с derived «Черновик» — поверх обычного статуса.
                const display = getDocumentDisplayStatus({
                  status: sd.status,
                  direction: sd.direction,
                  contractorId: sd.contractorId,
                  recipientId: sd.recipientId,
                  recipientMolId: sd.recipientMolId,
                  expectedDate: sd.expectedDate,
                  siteId: sd.siteId,
                });
                if (display === 'draft') {
                  return (
                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                      Черновик
                    </Tag>
                  );
                }
                return null;
              })()}
              <Tag
                style={{ marginInlineEnd: 0 }}
                color={
                  sd.kind === 'upd'
                    ? 'blue'
                    : sd.kind === 'transport_waybill' || sd.kind === 'os2_transfer'
                      ? 'purple'
                      : 'gold'
                }
              >
                {sd.kind === 'upd'
                  ? 'УПД'
                  : sd.kind === 'transport_waybill' || sd.kind === 'os2_transfer'
                    ? 'Накладная'
                    : 'Заявка'}
              </Tag>
              {sd.siteName ? <Tag style={{ marginInlineEnd: 0 }}>Объект: {sd.siteName}</Tag> : null}
              {/* Стороны документа — покупатель, грузополучатель, поставщик:
                  то, что распознано в шапке УПД. Подрядчик (выбор менеджера)
                  живёт ниже, в поле «Получатель» формы редактирования. */}
              {sd.buyerName ? (
                <Tag style={{ marginInlineEnd: 0 }}>
                  Покупатель: {shortenCounterpartyName(sd.buyerName)}
                </Tag>
              ) : null}
              {sd.consigneeName ? (
                <Tag style={{ marginInlineEnd: 0 }}>
                  Грузополучатель: {shortenCounterpartyName(sd.consigneeName)}
                </Tag>
              ) : null}
              {sd.recipientMolName ? (
                <Tag style={{ marginInlineEnd: 0 }}>МОЛ: {sd.recipientMolName}</Tag>
              ) : null}
              {sd.supplierName ? (
                <Tag style={{ marginInlineEnd: 0 }}>
                  Поставщик: {shortenCounterpartyName(sd.supplierName)}
                </Tag>
              ) : null}
              {/* Комментарий поставщика к поставке — приходит с публичной
                  страницы загрузки. Длинный текст обрезаем тегом, целиком
                  показываем в подсказке. */}
              {sd.submission?.comment ? (
                <Tooltip title={sd.submission.comment}>
                  <Tag
                    color="cyan"
                    style={{
                      marginInlineEnd: 0,
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Комментарий поставщика: {sd.submission.comment}
                  </Tag>
                </Tooltip>
              ) : null}
              {/* Чип «Уверенность: N%» убран по запросу — значение
                  llmConfidence остаётся в БД и контракте на случай если
                  понадобится вернуть. */}
            </Space>
          ) : (
            'Документ'
          )
        }
        width="97vw"
        style={{ top: 4, paddingBottom: 0 }}
        styles={{
          header: { padding: '8px 16px', marginBottom: 0 },
          // Высота body ограничена так, чтобы footer с «Сохранить» всегда
          // оставался виден без скролла страницы. 150px = top(4) + header
          // с wrap-чипами (~80) + footer (~50) + paddings и буфер. Внутри
          // body — flex column: Alert-сообщения сверху статично, DetailBody
          // растягивается на оставшееся (flex:1) и скроллит внутри себя.
          body: {
            padding: '6px 12px',
            height: 'calc(100vh - 150px)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
          footer: { padding: '6px 12px' },
          // См. DeliveryViewModal: убираем «вспышку таблицы» при закрытии
          // через мгновенное скрытие маски и обёртки.
          mask: { transitionDuration: '0s' },
          wrapper: { transitionDuration: '0s' },
        }}
        footer={
          sd ? (
            <Space wrap>
              {role === 'admin' && (
                <Button onClick={() => setLlmDrawerOpen(true)}>Логи распознавания</Button>
              )}
              {/* Доп. документы поставки — только скачивание и только отсюда:
                  в шапке карточки они больше не показываются, чтобы не отнимать
                  высоту у позиций и превью. Видны всем, кому открылась карточка. */}
              {sd.extraFiles.length > 0 && (
                <ExtraFilesFooterButton files={sd.extraFiles} documentId={id!} />
              )}
              {isMismatchPending && (
                <Button onClick={() => ack.mutate()} loading={ack.isPending}>
                  Принять как есть
                </Button>
              )}
              {canReparse && !isProcessing && (
                <Popconfirm
                  title="Распознать документ заново?"
                  description="Файл сохранится, но текущие распознанные данные заменятся, а точные связи строк приёмки с позициями документа сбросятся."
                  okText="Распознать"
                  cancelText="Отмена"
                  onConfirm={() => reparse.mutate()}
                >
                  <Button icon={<ReloadOutlined />} loading={reparse.isPending}>
                    Распознать повторно
                  </Button>
                </Popconfirm>
              )}
              {canReparse && canRecoverWork && (
                <Popconfirm
                  title="Восстановить распознавание?"
                  description="Сервер создаст новую защищённую попытку или зафиксирует видимый итог, если лимит исчерпан."
                  okText="Восстановить"
                  cancelText="Отмена"
                  onConfirm={() => recover.mutate()}
                >
                  <Button danger icon={<ReloadOutlined />} loading={recover.isPending}>
                    Восстановить распознавание
                  </Button>
                </Popconfirm>
              )}
              {!isProcessing && !isDuplicate && (
                // Popconfirm с disabled: пока очистка даты машине не грозит, он
                // отключён и клик уходит прямо в onSave — лишнего шага у обычного
                // сохранения не появляется.
                <Popconfirm
                  title="Снять дату поставки у всей машины?"
                  description={`Без даты поставка целиком (${sd?.portalGroupSize ?? 0} док.) пропадёт у инспектора на планшете.`}
                  okText="Снять дату"
                  cancelText="Отмена"
                  disabled={!clearsMachineDate}
                  onConfirm={onSave}
                >
                  <Button
                    type="primary"
                    onClick={clearsMachineDate ? undefined : onSave}
                    loading={patch.isPending}
                  >
                    Сохранить
                  </Button>
                </Popconfirm>
              )}
            </Space>
          ) : null
        }
        destroyOnClose
        transitionName=""
      >
        {detail.isLoading && (
          <Space direction="vertical" align="center" style={{ width: '100%', padding: 32 }}>
            <Spin size="large" />
          </Space>
        )}
        {detail.error && (
          <Alert
            type="error"
            message="Не удалось загрузить документ"
            description={(detail.error as Error).message}
            showIcon
          />
        )}
        {sd && (
          <>
            {isProcessing && (
              <Alert
                style={{ marginBottom: 12 }}
                type={canRecoverWork ? 'warning' : 'info'}
                showIcon
                message={
                  canRecoverWork
                    ? 'Распознавание требует восстановления'
                    : 'Документ ещё распознаётся'
                }
                description={
                  canRecoverWork
                    ? 'Задание отсутствует, завершилось без результата или превысило лимит времени.'
                    : sd.workHealth === 'unknown'
                      ? 'Состояние очереди временно не удалось проверить. Проверка повторится автоматически.'
                      : 'Окно обновится автоматически, когда распознавание завершится.'
                }
              />
            )}
            {/* Повтор не удался — документ вернулся к прежним данным. Без этого
                сообщения откат выглядел бы как «кнопка ничего не сделала»:
                статус и поля остались ровно теми же. */}
            {sd.reparse?.state === 'failed' && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="Повторное распознавание не удалось"
                description={
                  sd.reparse.reason
                    ? `Документ оставлен без изменений. Причина: ${sd.reparse.reason}`
                    : 'Документ оставлен без изменений.'
                }
              />
            )}
            {isDuplicate && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="Это дубликат уже существующего УПД"
                description="Откройте список «Документы» и нажмите «Разрешить» в строке этого документа."
              />
            )}
            {sd.status === 'parse_failed' && (
              <Alert
                style={{ marginBottom: 12 }}
                type="error"
                showIcon
                message={`Ошибка распознавания: ${sd.parseErrorCode ?? 'unknown'}`}
                description={(sd.parseErrorDetails as { message?: string } | null)?.message ?? null}
              />
            )}
            {/* flexShrink:0 — блок не должен сжиматься в flex-колонке body;
                maxHeight + внутренний скролл — страховка на случай, когда
                пользователь оставил список развёрнутым: DetailBody ниже всё
                равно получает большую часть высоты и остаётся рабочим. */}
            {(failedChecks.length > 0 || warnings.length > 0) && (
              <div
                style={{
                  flexShrink: 0,
                  maxHeight: '22vh',
                  overflowY: 'auto',
                  marginBottom: 12,
                }}
              >
                <UpdValidationSummary failedChecks={failedChecks} warnings={warnings} />
              </div>
            )}
            <DetailBody
              isWide={isWide}
              layout={layout}
              setLayout={setLayout}
              itemsNode={
                edit && !isProcessing && !isDuplicate ? (
                  <EditableTable
                    edit={edit}
                    setEdit={setEdit}
                    failedRows={
                      new Set(
                        failedChecks
                          .map((c) => (typeof c.scope === 'object' ? c.scope.row : null))
                          .filter((x): x is number => x != null),
                      )
                    }
                  />
                ) : (
                  <SourceDocumentItemsTable
                    items={items}
                    showInvNumber={sd.kind === 'os2_transfer'}
                    withVat={sd.kind === 'upd'}
                    docTotalSum={sd.totalSum}
                    docVatSum={sd.vatSum}
                  />
                )
              }
              headerNode={
                edit && !isProcessing && !isDuplicate ? (
                  <Form layout="vertical" style={{ maxWidth: 500 }}>
                    <Form.Item label="№ документа">
                      <Input
                        value={edit.docNumber ?? ''}
                        onChange={(e) => setEdit({ ...edit, docNumber: e.target.value || null })}
                      />
                    </Form.Item>
                    <Form.Item label="Дата">
                      <DatePicker
                        value={edit.docDate}
                        onChange={(d) => setEdit({ ...edit, docDate: d })}
                        format="DD.MM.YYYY"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item label="Сумма">
                      <InputNumber
                        value={edit.totalSum != null ? Number(edit.totalSum) : null}
                        onChange={(v) =>
                          setEdit({ ...edit, totalSum: v != null ? String(v) : null })
                        }
                        decimalSeparator=","
                        formatter={inputNumberFormatterRu}
                        parser={inputNumberParserRu}
                        addonAfter="₽"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Дата поставки"
                      // Дата поставки описывает РЕЙС, а не бумагу: у машины с
                      // портала она общая, поэтому смена здесь переносит её на
                      // все документы поставки и на сам пакет (см.
                      // transferExpectedDate на сервере). Разъехавшись по дням,
                      // машина ломает инспектору вкладку «Сегодня», а пустая
                      // дата у одной строки гасит поставку целиком.
                      extra={
                        sd.portalGroupId
                          ? `Поставка загружена через портал: дата сменится у всей машины${
                              sd.portalGroupSize ? ` (${sd.portalGroupSize} док.)` : ''
                            }.`
                          : undefined
                      }
                    >
                      <DatePicker
                        value={edit.expectedDate}
                        onChange={(d) => setEdit({ ...edit, expectedDate: d })}
                        format="DD.MM.YYYY"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    {sd.direction === 'outbound' ? (
                      <Form.Item label="Получатель">
                        <Segmented
                          block
                          style={{ marginBottom: 8 }}
                          value={edit.recipientKind}
                          onChange={(v) => {
                            const next = v as 'counterparty' | 'mol';
                            // Чистим «противоположное» поле, чтобы при save XOR
                            // отправлял правильную пару.
                            setEdit({
                              ...edit,
                              recipientKind: next,
                              recipientId: next === 'counterparty' ? edit.recipientId : null,
                              recipientMolId: next === 'mol' ? edit.recipientMolId : null,
                            });
                          }}
                          options={[
                            { label: 'Контрагент', value: 'counterparty' },
                            { label: 'МОЛ', value: 'mol' },
                          ]}
                        />
                        {edit.recipientKind === 'counterparty' ? (
                          <CustomerCounterpartySelect
                            value={edit.recipientId}
                            displayName={sd.recipientName ?? null}
                            onChange={(v) => setEdit({ ...edit, recipientId: v })}
                            placeholder="Выберите получателя"
                          />
                        ) : (
                          <ResponsiblePersonSelect
                            value={edit.recipientMolId}
                            onChange={(v) => setEdit({ ...edit, recipientMolId: v })}
                            placeholder="Выберите получателя"
                            source="fot"
                          />
                        )}
                      </Form.Item>
                    ) : (
                      <>
                        {/* Приёмка: подрядчик из карточки НЕ выбирается. Кому
                            адресован груз, говорит сам документ — грузополучатель
                            и покупатель, — и ровно их же показывает планшет при
                            выборе УПД. Подрядчик остался внутренней привязкой
                            затрат: на «Обработано» и на выдачу инспектору он не
                            влияет, а выбор из карточки только путал — резолвер
                            подставлял туда покупателя, у субподряда это
                            генподрядчик. */}
                        <Form.Item label="Стороны по документу">
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            Грузополучатель:{' '}
                            {sd.consigneeName ? (
                              shortenCounterpartyName(sd.consigneeName)
                            ) : (
                              <Typography.Text type="secondary">не распознан</Typography.Text>
                            )}
                          </Typography.Paragraph>
                          <Typography.Paragraph style={{ marginBottom: 0 }}>
                            Покупатель:{' '}
                            {sd.buyerName ? (
                              shortenCounterpartyName(sd.buyerName)
                            ) : (
                              <Typography.Text type="secondary">не распознан</Typography.Text>
                            )}
                          </Typography.Paragraph>
                        </Form.Item>
                        <Form.Item
                          label="МОЛ"
                          extra="Заполняется, если груз принимает материально ответственное лицо."
                        >
                          <ResponsiblePersonSelect
                            value={edit.recipientMolId}
                            onChange={(v) => setEdit({ ...edit, recipientMolId: v })}
                            placeholder="Выберите МОЛ"
                            source="fot"
                          />
                        </Form.Item>
                      </>
                    )}
                    <Form.Item
                      label="Объект"
                      // Поставка с портала — это машина: несколько документов
                      // одного рейса. Объект у неё общий, поэтому смена здесь
                      // переносит ВСЮ машину вместе с пакетом (см. transferSite
                      // на сервере). Менеджер должен знать это до сохранения.
                      extra={
                        sd.portalGroupId
                          ? `Поставка загружена через портал: объект сменится у всей машины${
                              sd.portalGroupSize ? ` (${sd.portalGroupSize} док.)` : ''
                            }.`
                          : undefined
                      }
                    >
                      <SiteSelect
                        value={edit.siteId}
                        onChange={(v) => setEdit({ ...edit, siteId: v })}
                        currentLabel={sd.siteName}
                      />
                    </Form.Item>
                  </Form>
                ) : (
                  <ReadOnlyHeader sd={sd} />
                )
              }
              originalNode={
                sd.attachments.length > 0 ? (
                  <DocumentOriginalViewer attachments={sd.attachments} id={id!} compact={isWide} />
                ) : file.isLoading ? (
                  <Spin />
                ) : (
                  <Typography.Text type="secondary">
                    {file.error instanceof ApiError && file.error.status === 404
                      ? 'Оригинальный файл недоступен (документ загружен из XML).'
                      : 'Не удалось получить оригинал.'}
                  </Typography.Text>
                )
              }
              itemsCount={edit?.items.length ?? items.length}
              attachmentsCount={sd.attachments.length}
            />
          </>
        )}
      </Modal>
      <LlmCallsDrawer
        sourceDocumentId={id}
        open={llmDrawerOpen}
        onClose={() => setLlmDrawerOpen(false)}
      />
    </>
  );
}

// Доля высоты, отдаваемая верхней панели «Позиции» в stacked-layout — растёт
// с количеством позиций, но НИКОГДА выше 50% (cap). После cap'а последнюю
// добавленную позицию показывает auto-scroll внутри таблицы.
function computeStackedTopPct(itemsCount: number): number {
  if (itemsCount <= 2) return 22;
  if (itemsCount <= 5) return 32;
  if (itemsCount <= 10) return 42;
  return 50;
}

// Тело модалки: на широком экране — Collapse «Реквизиты» + Splitter «Позиции/Оригинал»
// с toggle ориентации; на узком — старые вкладки Позиции/Шапка/Оригинал (PDF в split
// на 700px нечитаем). Высота 92vh — рассчитана под чипы шапки модалки и футер с
// кнопками; внутри Splitter растягивается по flex.
function DetailBody({
  isWide,
  layout,
  setLayout,
  itemsNode,
  headerNode,
  originalNode,
  itemsCount,
  attachmentsCount,
}: {
  isWide: boolean;
  layout: SplitMode;
  setLayout: (next: SplitMode) => void;
  itemsNode: ReactNode;
  headerNode: ReactNode;
  originalNode: ReactNode;
  itemsCount: number;
  attachmentsCount: number;
}): JSX.Element {
  // Controlled-размер верхней панели в пикселях. null = используем defaultSize
  // от antd Splitter (только до первого автоматического или ручного resize).
  const [topSizePx, setTopSizePx] = useState<number | null>(null);
  const splitterBoxRef = useRef<HTMLDivElement | null>(null);
  const topPaneRef = useRef<HTMLDivElement | null>(null);
  const prevItemsCount = useRef(itemsCount);

  // При росте itemsCount (пользователь нажал «Добавить позицию»):
  //   1. Опускаем границу Splitter'а вниз до computeStackedTopPct(n), но
  //      не выше 50% (cap). Не трогаем, если итоговый размер меньше
  //      текущего — пользовательский ручной resize не сбрасываем.
  //   2. Скроллим tbody таблицы к низу, чтобы свежедобавленная строка
  //      всегда была в поле зрения (особенно после того, как граница
  //      упёрлась в cap 50% и больше двигаться не может).
  // При уменьшении (удалили строку) — оставляем границу где она была:
  // пользователь сам подгоняет, если хочет дать УПД больше места.
  useEffect(() => {
    const grew = itemsCount > prevItemsCount.current;
    prevItemsCount.current = itemsCount;
    if (!grew) return;

    if (layout === 'stacked' && splitterBoxRef.current) {
      const totalH = splitterBoxRef.current.clientHeight;
      if (totalH > 0) {
        const targetPct = Math.min(computeStackedTopPct(itemsCount), 50);
        const targetPx = (targetPct / 100) * totalH;
        setTopSizePx((prev) => Math.max(prev ?? 0, targetPx));
      }
    }

    // Auto-scroll к низу панели «Позиции» — внешнего скроллера, не tbody.
    // Так в видимой области оказывается и свежедобавленная строка, и
    // кнопка «+ Добавить позицию» сразу под таблицей: пользователю не
    // приходится скроллить, чтобы её увидеть и кликнуть ещё раз.
    // requestAnimationFrame — чтобы antd успел перерисовать таблицу
    // после setEdit, иначе scrollHeight ещё не учитывает новую строку.
    const pane = topPaneRef.current;
    if (pane) {
      requestAnimationFrame(() => {
        pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [itemsCount, layout]);

  if (!isWide) {
    return (
      <Tabs
        defaultActiveKey="items"
        items={[
          {
            key: 'items',
            label: `Позиции (${itemsCount})`,
            children: itemsNode,
          },
          {
            key: 'header',
            label: 'Шапка',
            children: headerNode,
          },
          {
            key: 'original',
            label: attachmentsCount > 1 ? `Оригинал (${attachmentsCount})` : 'Оригинал',
            children: originalNode,
          },
        ]}
      />
    );
  }

  // antd Splitter: layout='vertical' = панели стекируются (разделитель горизонтальный);
  // layout='horizontal' = панели бок о бок (разделитель вертикальный).
  const splitterLayout: 'vertical' | 'horizontal' =
    layout === 'stacked' ? 'vertical' : 'horizontal';

  // Размер панели «Позиции» по умолчанию: подбираем так, чтобы редактируемая
  // таблица (6 колонок: №/Наименование/Кол-во/Ед./Цена/Сумма + кнопка
  // удалить) помещалась без горизонтального скролла.
  //
  // sideBySide — границей решает ширина: editable-таблица с InputNumber+₽
  // требует минимум ~700px. Меньше — и колонки «Цена»/«Сумма» обрезаются,
  // символ ₽ не помещается. Поэтому отдаём пиксели, не %.
  const splitterMin: number | string = layout === 'sideBySide' ? 700 : '15%';
  function defaultItemsSize(): number | string {
    if (layout === 'sideBySide') {
      // Чуть больше для запаса; пользователь может сузить вручную.
      return itemsCount > 10 ? 800 : 720;
    }
    return `${computeStackedTopPct(itemsCount)}%`;
  }

  // controlled-размер применяем только в stacked. В sideBySide и при первом
  // mount'е (topSizePx === null) — отдаём defaultSize, antd сам решает.
  const controlledTopSize: number | undefined =
    layout === 'stacked' && topSizePx != null ? topSizePx : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 2,
        }}
      >
        <Collapse
          ghost
          size="small"
          style={{ flex: 1 }}
          items={[
            {
              key: 'header',
              label: 'Реквизиты документа',
              children: <div style={{ padding: '4px 0' }}>{headerNode}</div>,
            },
          ]}
        />
        <Tooltip title="Расположение панелей: позиции и оригинал">
          <Segmented
            size="small"
            value={layout}
            onChange={(v) => setLayout(v as SplitMode)}
            options={[
              {
                value: 'stacked',
                icon: <BorderHorizontalOutlined />,
                title: 'Сверху/снизу',
              },
              {
                value: 'sideBySide',
                icon: <BorderVerticleOutlined />,
                title: 'Слева/справа',
              },
            ]}
          />
        </Tooltip>
      </div>
      <div
        ref={splitterBoxRef}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <Splitter
          key={splitterLayout}
          layout={splitterLayout}
          onResize={(sizes) => {
            // onResize срабатывает и при ручном drag'е, и при автоматическом
            // сдвиге через size. В обоих случаях фиксируем актуальные пиксели,
            // чтобы следующий ручной drag начинался от текущей позиции.
            if (layout === 'stacked' && typeof sizes[0] === 'number') {
              setTopSizePx(sizes[0]);
            }
          }}
          style={{ flex: 1, minHeight: 0, border: '1px solid #f0f0f0', borderRadius: 4 }}
        >
          <Splitter.Panel
            min={splitterMin}
            defaultSize={defaultItemsSize()}
            size={controlledTopSize}
            // antd .ant-splitter-panel по умолчанию overflow:auto — давал лишний
            // «внешний» скролл панели поверх внутреннего скролла таблицы (наш div
            // ниже, ref=topPaneRef). Гасим его — остаётся единственный, внутренний.
            style={{ overflow: 'hidden' }}
          >
            <div
              ref={topPaneRef}
              style={{
                height: '100%',
                overflow: 'auto',
                padding: 8,
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Позиции ({itemsCount})
              </Typography.Text>
              <div style={{ marginTop: 4 }}>{itemsNode}</div>
            </div>
          </Splitter.Panel>
          {/* style overflow:hidden — гасим дефолтный overflow:auto antd-панели,
              чтобы не было «внешнего» скролла поверх внутреннего скролла PDF
              (iframe Chrome-viewer'а). */}
          <Splitter.Panel min="20%" style={{ overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                padding: 8,
                overflow: 'hidden',
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
                Оригинал{attachmentsCount > 1 ? ` (${attachmentsCount})` : ''}
              </Typography.Text>
              {/* overflow:hidden у обёртки + DocumentOriginalViewer сам занимает
                  100% (lightbox с iframe/Image имеет внутренний скролл).
                  Раньше тут был overflow:auto — давало лишний правый скролл
                  поверх iframe PDF-viewer'а. */}
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{originalNode}</div>
            </div>
          </Splitter.Panel>
        </Splitter>
      </div>
    </div>
  );
}

function ReadOnlyHeader({ sd }: { sd: SourceDocumentDetail }) {
  return (
    <Space direction="vertical">
      <Typography.Text>
        <b>№:</b> {sd.docNumber ?? '—'}
      </Typography.Text>
      <Typography.Text>
        <b>Дата:</b> {formatDateRu(sd.docDate)}
      </Typography.Text>
      <Typography.Text>
        <b>Сумма:</b> {formatMoneyRu(sd.totalSum)}
      </Typography.Text>
      <Typography.Text type="secondary">НДС: {formatMoneyRu(sd.vatSum)}</Typography.Text>
      <Typography.Text>
        <b>Дата поставки:</b> {formatDateRu(sd.expectedDate)}
      </Typography.Text>
      {sd.direction === 'outbound' ? (
        <Typography.Text>
          <b>Получатель:</b>{' '}
          {sd.recipientMolName
            ? `${sd.recipientMolName} (МОЛ)`
            : sd.contractorName
              ? `${shortenCounterpartyName(sd.contractorName)} (подрядчик)`
              : '—'}
        </Typography.Text>
      ) : (
        <>
          {/* Приёмка: кому адресован груз, говорит сам документ — то же, что
              видит инспектор на планшете. Подрядчик отсюда убран вместе с его
              выбором в форме. */}
          <Typography.Text>
            <b>Грузополучатель:</b>{' '}
            {sd.consigneeName ? shortenCounterpartyName(sd.consigneeName) : '—'}
          </Typography.Text>
          <Typography.Text>
            <b>Покупатель:</b> {sd.buyerName ? shortenCounterpartyName(sd.buyerName) : '—'}
          </Typography.Text>
          {sd.recipientMolName ? (
            <Typography.Text>
              <b>МОЛ:</b> {sd.recipientMolName}
            </Typography.Text>
          ) : null}
        </>
      )}
      <Typography.Text>
        <b>Объект:</b> {sd.siteName ?? '—'}
      </Typography.Text>
    </Space>
  );
}

function EditableTable({
  edit,
  setEdit,
  failedRows,
}: {
  edit: EditForm;
  setEdit: (v: EditForm) => void;
  failedRows: ReadonlySet<number>;
}) {
  // Цена показывается с налогом там, где у формы есть источник ставки, — то
  // есть только у УПД (см. initialForm). Отдельного пропа не нужно: признак
  // уже едет в самой форме.
  const withVat = edit.vatSource != null;
  function updateItem(idx: number, patch: Partial<EditItem>) {
    const next = edit.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    setEdit({ ...edit, items: next });
  }
  function removeItem(idx: number) {
    setEdit({ ...edit, items: edit.items.filter((_, i) => i !== idx) });
  }
  function addItem() {
    setEdit({
      ...edit,
      items: [
        ...edit.items,
        // Ставки у новой строки нет: цена пересчитается по ставке документа.
        {
          nameRaw: '',
          qty: '1',
          unit: 'шт',
          price: null,
          sum: null,
          vatRate: null,
          priceGross: null,
        },
      ],
    });
  }

  return (
    <>
      {/* componentSize="small" — поля ввода в ячейках 24px, как в остальных
          таблицах приложения. Без этого строки режима редактирования были бы
          ~45px против ~34px у соседней таблицы просмотра, и высота прыгала бы
          при переключении режима. */}
      <ConfigProvider componentSize="small">
        <Table<EditItem & { idx: number }>
          dataSource={edit.items.map((it, idx) => ({ ...it, idx }))}
          rowKey="idx"
          size="small"
          pagination={false}
          showSorterTooltip={false}
          // scroll={y} убран намеренно: с внутренним tbody-скроллом кнопка
          // «Добавить позицию» уезжала за нижний край панели и её не было
          // видно. Теперь Table растягивается по содержимому, скроллит
          // внешний контейнер Splitter.Panel — и при auto-scroll к низу
          // (см. DetailBody) кнопка остаётся в видимой части.
          rowClassName={(r) => (failedRows.has(r.idx + 1) ? 'matcheck-row-mismatch' : '')}
          columns={[
            { title: '№', dataIndex: 'idx', width: 50, render: (idx: number) => idx + 1 },
            {
              title: 'Наименование',
              dataIndex: 'nameRaw',
              render: (v: string, _r, i) => (
                <Input value={v} onChange={(e) => updateItem(i, { nameRaw: e.target.value })} />
              ),
            },
            {
              title: 'Кол-во',
              dataIndex: 'qty',
              width: 110,
              render: (v: string, _r, i) => (
                <InputNumber
                  value={Number(v)}
                  onChange={(x) => updateItem(i, { qty: String(x ?? 0) })}
                  decimalSeparator=","
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: 'Ед.',
              dataIndex: 'unit',
              width: 100,
              // size не задаём: внутри ConfigProvider выше селект берёт тот же
              // компактный размер, что и соседние поля строки.
              render: (v: string, _r, i) => (
                <UnitSelect
                  value={v}
                  onChange={(nv) => updateItem(i, { unit: nv ?? '' })}
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              // Показываем и принимаем цену С НАЛОГОМ, но в форме храним цену
              // бланка: `value` пересчитывается на лету, а `onChange`
              // возвращает введённое обратно к графе 4. Строка, которую не
              // трогали, так и остаётся с исходным `price` — байт в байт.
              title: withVat ? 'Цена с НДС' : 'Цена',
              // Правится цена С НАЛОГОМ, а в базу уходит цена бланка — перевод
              // делает priceForSave при сохранении, и только для изменённых строк.
              dataIndex: 'priceGross',
              width: 160,
              render: (v: number | null, _r, i) => (
                <InputNumber
                  value={v}
                  onChange={(x) =>
                    updateItem(i, { priceGross: typeof x === 'number' ? x : null })
                  }
                  decimalSeparator=","
                  formatter={inputNumberFormatterRu}
                  parser={inputNumberParserRu}
                  addonAfter="₽"
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: 'Сумма',
              dataIndex: 'sum',
              width: 180,
              render: (v: string | null, _r, i) => (
                <InputNumber
                  value={v != null ? Number(v) : null}
                  onChange={(x) => updateItem(i, { sum: x != null ? String(x) : null })}
                  decimalSeparator=","
                  formatter={inputNumberFormatterRu}
                  parser={inputNumberParserRu}
                  addonAfter="₽"
                  style={{ width: '100%' }}
                />
              ),
            },
            {
              title: '',
              key: 'rm',
              width: 50,
              render: (_v, _r, i) => (
                <Button
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => removeItem(i)}
                />
              ),
            },
          ]}
        />
      </ConfigProvider>
      <Button
        icon={<PlusOutlined />}
        onClick={addItem}
        style={{ marginTop: 8 }}
        type="dashed"
        block
      >
        Добавить позицию
      </Button>

    </>
  );
}
