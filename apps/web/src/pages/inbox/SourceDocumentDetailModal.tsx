import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Collapse,
  ConfigProvider,
  DatePicker,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Splitter,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResponsiblePerson,
  SourceDirection,
  SourceDocumentDetail,
  SourceDocumentFileResponse,
  SourceDocumentPagesResponse,
  SourceRecoverResponse,
  SourceReparseResponse,
  UpdCheck,
  UpdWarning,
} from '@matcheck/contracts';
import { getDocumentDisplayStatus } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { api, apiDownload, ApiError } from '../../services/api';
import { formatDecimal } from '../../shared/utils/formatDecimal';
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
import { SiteSelect } from './SiteSelect';
import { ResponsiblePersonSelect } from '../../components/ResponsiblePersonSelect';

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

function describeCheck(c: UpdCheck): string {
  const where = c.scope === 'document' ? 'по документу' : `строка ${c.scope.row}`;
  const name =
    {
      sum_total: 'сумма позиций vs итог документа',
      vat_total: 'НДС позиций vs НДС документа',
      items_count: 'количество позиций vs «Всего наименований»',
      items_sequence: 'номера позиций идут не подряд — строка потеряна или задвоена',
      row_qty_price: 'qty × price ≠ sum',
      row_vat_rate: 'sum × ставка ≠ НДС',
    }[c.name] || c.name;
  const exp = c.expected != null ? c.expected.toFixed(2) : '—';
  const act = c.actual != null ? c.actual.toFixed(2) : '—';
  return `${name} (${where}): ожидается ${exp}, по факту ${act}`;
}

/**
 * Подозрения читаются иначе, чем расхождения: арифметика сошлась, доказательства
 * нет — есть только повод перепроверить строку глазами по бумаге.
 */
function describeWarning(w: UpdWarning): string {
  const where = w.scope === 'document' ? 'по документу' : `строка ${w.scope.row}`;
  const name =
    {
      qty_price_swap: 'похоже, количество и цена стоят не в своих колонках',
      unit_code_as_qty: 'в количестве стоит код единицы измерения из бланка, а не количество',
      sum_equals_qty: 'сумма совпадает с количеством — похоже, в бумаге цены нет',
      unit_price_one: 'цена ровно 1 — проверьте, напечатана ли она в документе',
      price_includes_vat: 'цена взята с НДС: количество × цена дало стоимость с налогом вместо графы 4',
      consignee_copy_unverified:
        'грузополучатель совпал с покупателем, но в графе 4 напечатано другое',
    }[w.name] || w.name;
  return `${name} (${where})`;
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

  const responsiblePersonsQuery = useQuery({
    queryKey: ['responsible-persons', 'active'],
    queryFn: () =>
      api.get<{ items: ResponsiblePerson[]; total: number }>(
        '/responsible-persons?activeOnly=true&limit=500',
      ),
  });
  const responsiblePersons = responsiblePersonsQuery.data?.items ?? [];

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
                <Button type="primary" onClick={onSave} loading={patch.isPending}>
                  Сохранить
                </Button>
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
            {failedChecks.length > 0 && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="Расхождения в суммах"
                description={
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {failedChecks.map((c, i) => (
                      <li key={i}>{describeCheck(c)}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {warnings.length > 0 && (
              <Alert
                style={{ marginBottom: 12 }}
                type="info"
                showIcon
                message="Проверьте строки по документу"
                description={
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {warnings.map((w, i) => (
                      <li key={i}>{describeWarning(w)}</li>
                    ))}
                  </ul>
                }
              />
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
                  <ReadOnlyTable
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
                    <Form.Item label="Дата поставки">
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
                  <OriginalAttachments attachments={sd.attachments} id={id!} compact={isWide} />
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
              {/* overflow:hidden у обёртки + OriginalAttachments сам занимает
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

// Минимальный набор полей attachment, которого хватает для рендера превью.
// Берём подмножество SourceAttachment — компонент не зависит от других
// полей DTO (role/s3Key и пр.), это упрощает тесты и переиспользование.
type AttachmentLike = {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
};

// Lightbox-паттерн: одно вложение крупно + полоса миниатюр снизу для
// переключения. Раньше стекали все вложения 1/N высоты — для ТН с
// 3–4 фото каждое уменьшалось до нечитаемого размера.
function OriginalAttachments({
  attachments,
  id,
  compact,
}: {
  attachments: ReadonlyArray<AttachmentLike>;
  id: string;
  // compact=true — внутри Splitter (правая/нижняя панель), занимает 100% высоты;
  // compact=false — внутри Tabs (узкий экран), фиксированная высота как раньше.
  compact: boolean;
}) {
  const [activeId, setActiveId] = useState<string | null>(attachments[0]?.id ?? null);

  // Страницы этого документа внутри файла. Пакет из одного PDF режут на
  // несколько УПД, а вложением к карточке остаётся файл целиком — без этой
  // подсказки вьюер открывал двадцатистраничный скан с первой страницы, и
  // менеджер видел на экране чужой лист вместо позиций своего документа.
  // Отдельный маршрут: то же поле в DTO документа уехало бы и на планшет.
  const pagesQuery = useQuery({
    queryKey: ['source-document-pages', id],
    queryFn: () => api.get<SourceDocumentPagesResponse>(`/source-documents/${id}/pages`),
    staleTime: 5 * 60_000,
  });

  // Если открыли другой документ — attachments сменились, нужно сбросить
  // активный на первый. Сравниваем по списку id, потому что массив
  // attachments — readonly прокси с новой ссылкой на каждом ререндере.
  useEffect(() => {
    if (attachments.length === 0) {
      setActiveId(null);
      return;
    }
    if (!attachments.some((a) => a.id === activeId)) {
      setActiveId(attachments[0].id);
    }
  }, [attachments, activeId]);

  if (attachments.length === 0 || !activeId) return null;
  const active = attachments.find((a) => a.id === activeId) ?? attachments[0];
  if (!active) return null;
  const activeIndex = attachments.findIndex((a) => a.id === active.id);
  const activeUrl = `/api/v1/source-documents/${id}/file/raw?attachmentId=${active.id}`;
  const activePages =
    pagesQuery.data?.attachments.find((a) => a.attachmentId === active.id)?.pages ?? [];
  const pagesLabel = formatPagesLabel(activePages);
  // Chrome PDF Viewer понимает page= внутри того же fragment. Отдельный «#»
  // ломает якорь целиком, поэтому дописываем параметр к существующему.
  const pdfFragment = `#toolbar=1&navpanes=0${activePages.length > 0 ? `&page=${activePages[0]}` : ''}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        height: compact ? '100%' : '75vh',
        minHeight: 320,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 11, display: 'block', marginBottom: 2 }}
        >
          {attachments.length > 1
            ? `Фото ${activeIndex + 1} из ${attachments.length} · ${active.filename}`
            : active.filename}
          {pagesLabel ? ` · ${pagesLabel}` : ''}
        </Typography.Text>
        {isImageExt(active.filename, active.mimeType) ? (
          // antd Image даёт встроенный lightbox (zoom/rotate/fullscreen) —
          // для скана накладной это удобнее, чем image в <iframe>, где у
          // Chrome нет ни зума, ни поворота. Меняем active.id ⇒ Image
          // перегружает src.
          <div
            key={active.id}
            style={{
              flex: 1,
              minHeight: 200,
              border: '1px solid #f0f0f0',
              background: '#fafafa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <Image
              src={activeUrl}
              alt={active.filename}
              wrapperStyle={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              preview={{ mask: 'Открыть для зума' }}
            />
          </div>
        ) : isExcelExt(active.filename, active.mimeType) ? (
          // Excel в браузере inline не открывается (нет встроенного
          // viewer'а ни у Chrome, ни у Firefox). Раньше URL попадал в
          // <iframe> — браузер при загрузке iframe запускал автоматическое
          // скачивание xlsx. Теперь рендерим карточку: иконка + имя +
          // размер + явная кнопка «Скачать». Распознанные позиции уже
          // видны в левой/верхней панели «Позиции».
          <ExcelPreviewCard id={id} attachment={active} />
        ) : (
          <iframe
            key={active.id}
            // #toolbar=1&navpanes=0 — Chrome PDF Viewer прячет левую панель
            // с миниатюрами страниц, освобождая место для самого документа.
            src={`${activeUrl}${pdfFragment}`}
            title={active.filename}
            style={{
              flex: 1,
              width: '100%',
              minHeight: 200,
              border: '1px solid #f0f0f0',
            }}
          />
        )}
      </div>
      {attachments.length > 1 && (
        <ThumbBar attachments={attachments} activeId={activeId} onSelect={setActiveId} id={id} />
      )}
    </div>
  );
}

// Картинка ли это. Главный источник правды — mime-тип из БД: расширений у
// изображений больше, чем стоит перечислять. Боевой случай — .jfif (так
// Outlook и Windows сохраняют обычный JPEG): mime у файла image/jpeg, но по
// расширению он не опознавался, уходил в <iframe> вместо antd Image (без зума
// и лайтбокса), а в полосе миниатюр рисовался серой иконкой файла — инспектор
// не понимал, как открыть второе фото. Расширение остаётся запасным путём для
// вложений без mime.
function isImageExt(name: string, mimeType?: string | null): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith('image/')) return true;
  return /\.(jpe?g|jfif|jfi|pjpeg|png|webp|gif|bmp|heic|heif|avif)$/i.test(name);
}

function isExcelExt(name: string, mimeType?: string | null): boolean {
  if (/\.xlsx?$/i.test(name)) return true;
  if (!mimeType) return false;
  return mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel';
}

/**
 * «Стр. 17–20» для смежных страниц, «Стр. 15, 17» для разрывов.
 *
 * Диапазон не додумываем: сегмент собирается из адресов конкретных страниц, и
 * при пропуске посередине «17–20» соврало бы про два листа.
 */
function formatPagesLabel(pages: number[]): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return `Стр. ${pages[0]}`;
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  const contiguous = pages.every((p, i) => p === first + i);
  return contiguous ? `Стр. ${first}–${last}` : `Стр. ${pages.join(', ')}`;
}

function isPdfExt(name: string): boolean {
  return /\.pdf$/i.test(name);
}

function formatFileSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

async function downloadAttachment(id: string, attachment: AttachmentLike): Promise<void> {
  // download=1 заставляет сервер выставить Content-Disposition: attachment
  // даже для PDF/изображений; для xlsx attachment ставится автоматически
  // по mime-типу (см. routes/source-documents.ts). apiDownload сам
  // приклеивает префикс BASE='/api/v1' (см. services/api.ts), поэтому
  // здесь путь относительный — без `/api/v1/`, иначе получим двойной
  // префикс и 404 Route not found.
  const { blob, filename } = await apiDownload(
    `/source-documents/${id}/file/raw?attachmentId=${attachment.id}&download=1`,
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || attachment.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExcelPreviewCard({ id, attachment }: { id: string; attachment: AttachmentLike }) {
  const [downloading, setDownloading] = useState(false);
  const size = formatFileSize(attachment.sizeBytes);
  const handleDownload = async () => {
    try {
      setDownloading(true);
      await downloadAttachment(id, attachment);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Не удалось скачать файл');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div
      style={{
        flex: 1,
        minHeight: 200,
        border: '1px solid #f0f0f0',
        background: '#fafafa',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        gap: 12,
      }}
    >
      <FileExcelOutlined style={{ fontSize: 64, color: '#22863a' }} />
      <Typography.Text strong style={{ textAlign: 'center', wordBreak: 'break-word' }}>
        {attachment.filename}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Excel-файл{size ? ` · ${size}` : ''} · распознан
      </Typography.Text>
      <Button
        type="primary"
        icon={<DownloadOutlined />}
        loading={downloading}
        onClick={handleDownload}
      >
        Скачать оригинал
      </Button>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, textAlign: 'center', maxWidth: 380 }}
      >
        Браузер не отображает Excel внутри страницы. Реквизиты и позиции документа уже распознаны и
        доступны в панели «Позиции».
      </Typography.Text>
    </div>
  );
}

function ThumbBar({
  attachments,
  activeId,
  onSelect,
  id,
}: {
  attachments: ReadonlyArray<AttachmentLike>;
  activeId: string;
  onSelect: (id: string) => void;
  id: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 4,
        flexShrink: 0,
      }}
    >
      {attachments.map((a, i) => {
        const isImg = isImageExt(a.filename, a.mimeType);
        const isActive = a.id === activeId;
        const thumbUrl = `/api/v1/source-documents/${id}/file/raw?attachmentId=${a.id}`;
        const isPdf = isPdfExt(a.filename);
        const isExcel = isExcelExt(a.filename, a.mimeType);
        return (
          <Tooltip key={a.id} title={a.filename} placement="top">
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(a.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(a.id);
                }
              }}
              style={{
                flexShrink: 0,
                width: 64,
                height: 64,
                border: isActive ? '2px solid #1677ff' : '1px solid #d9d9d9',
                borderRadius: 4,
                cursor: 'pointer',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                background: '#fafafa',
                transition: 'border-color 0.15s',
              }}
            >
              {isImg ? (
                <img
                  src={thumbUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : isPdf ? (
                <FilePdfOutlined style={{ fontSize: 28, color: '#d4380d' }} />
              ) : isExcel ? (
                // Не подставляем xlsx-URL в <img> — браузер всё равно не
                // сможет его декодировать, а запрос дёрнет /file/raw → 200
                // и при некоторых настройках вызовет лишнюю сетевую работу.
                <FileExcelOutlined style={{ fontSize: 28, color: '#22863a' }} />
              ) : (
                <FileTextOutlined style={{ fontSize: 28, color: '#8c8c8c' }} />
              )}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  background: 'rgba(0,0,0,0.55)',
                  color: '#fff',
                  fontSize: 10,
                  textAlign: 'center',
                  padding: '1px 2px',
                  lineHeight: 1.2,
                }}
              >
                {i + 1}
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ReadOnlyTable({
  items,
  showInvNumber,
  withVat,
  docTotalSum,
  docVatSum,
}: {
  items: Item[];
  showInvNumber?: boolean;
  /**
   * Показывать цену С НАЛОГОМ. Только для УПД: там рядом стоит сумма из графы 9
   * (с налогом), и цена без налога из графы 4 не сходилась с ней на экране —
   * 15 × 240 против показанных 4 392. У накладных и ОС-2 колонка прежняя.
   */
  withVat?: boolean;
  /** Шапка документа — из неё берётся ставка для строк, где она не распозналась. */
  docTotalSum?: string | null;
  docVatSum?: string | null;
}) {
  // Колонка «Инв.№» отображается только для ОС-2 (kind='os2_transfer') —
  // у ТН и УПД она была бы пустой.
  const columns: NonNullable<ComponentProps<typeof Table<Item>>['columns']> = [
    { title: '№', dataIndex: 'lineNo', width: 50 },
    { title: 'Наименование', dataIndex: 'nameRaw' },
  ];
  if (showInvNumber) {
    columns.push({
      title: 'Инв.№',
      dataIndex: 'inventoryNumber',
      width: 110,
      render: (v: string | null) => v ?? '—',
    });
  }
  columns.push(
    {
      title: 'Кол-во',
      dataIndex: 'qty',
      width: 90,
      render: (v: string | null) => formatDecimal(v),
    },
    { title: 'Ед.', dataIndex: 'unit', width: 60 },
    {
      // Заголовок называет величину прямо: в приёмке цена остаётся без налога,
      // и одинаковое имя над разными числами читалось бы как расхождение.
      title: withVat ? 'Цена с НДС' : 'Цена',
      dataIndex: 'price',
      width: 130,
      render: (v: string | null, r: Item) =>
        formatMoneyRu(withVat ? priceWithVat(v, r.vatRate, docTotalSum, docVatSum) : v),
    },
    {
      title: 'Сумма',
      dataIndex: 'sum',
      width: 150,
      render: (v: string | null) => formatMoneyRu(v),
    },
  );
  return (
    <Table<Item>
      dataSource={items}
      rowKey="id"
      size="small"
      pagination={false}
      showSorterTooltip={false}
      // scroll={y} убран — давал внутренний tbody-скролл поверх скролла
      // Splitter.Panel. Тaблица растягивается по содержимому, скроллит
      // только внешняя панель.
      columns={columns}
    />
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
      <style>{`.matcheck-row-mismatch td { background-color: #fff7e6 !important; }`}</style>
    </>
  );
}
