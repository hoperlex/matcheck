import type { MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
  type TableProps,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  MailOutlined,
  CloudUploadOutlined,
  MinusSquareOutlined,
  PlusSquareOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clusterRowsByGroup,
  documentGroupKey,
  GROUP_COLORS,
  groupRowClass,
} from '../../shared/ui/documentGroupRows';
import { isPendingRow, pendingAsRow, pendingStateOf } from './pendingRow';
import { buildDocumentListParams, type DocumentListParamsInput } from './listParams';
import type {
  CustomerCounterparty,
  Site,
  SourceDirection,
  SourceDocumentBulkDeleteResponse,
  SourceDocumentListResponseSchema,
  SourceRecoverResponse,
  SourceReparseResponse,
  Supplier,
} from '@matcheck/contracts';
import { getDocumentDisplayStatus, isActionableStub, isStubDocument } from '@matcheck/contracts';
import type { z } from 'zod';
import { api, apiDownload, ApiError } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { ResponsiveTable } from '../../shared/ui/ResponsiveTable';
import { StickyPageHeader } from '../../shared/ui/StickyPageHeader';
import { ListFilters, type ListFiltersValue } from '../../shared/ui/ListFilters';
import { PageTabs, type PageTabItem } from '../../shared/ui/PageTabs';
import { parseDateRangeKey, serverDateRangeColumnFilter } from '../../shared/ui/DateRangeFilter';
import { useBulkSelection } from '../../shared/ui/useBulkSelection';
import { ActiveFilterChips, type ActiveFilterChip } from '../../shared/ui/ActiveFilterChips';
import { ExpandedSourceDocumentItems } from '../../shared/ui/ExpandedSourceDocumentItems';
import { usePrefetchSourceDocumentDetails } from '../../shared/hooks/usePrefetchSourceDocumentDetails';
import { parseCsvIds, toCsvIds } from '../../shared/utils/csvIds';
import { patchSearchParams, type SearchParamsPatch } from '../../shared/utils/searchParams';
import { shortenCounterpartyName } from '../../shared/utils/companyShortName';
import { documentPartyColumns } from '../../shared/ui/documentPartyColumns';
import { useSyncGlobalFilters } from '../../shared/hooks/useSyncGlobalFilters';
import { formatDecimal } from '../../shared/utils/formatDecimal';
import { formatDateRu, formatMoneyRu } from '../../shared/utils/formatRu';
import { UpdPdfUploadModal } from './UpdPdfUploadModal';
import { WaybillUploadModal } from './WaybillUploadModal';
import { UploadDocumentsModal } from './UploadDocumentsModal';
import { SourceDocumentDetailModal } from './SourceDocumentDetailModal';
import { UpdResolveDuplicateModal } from './UpdResolveDuplicateModal';

type List = z.infer<typeof SourceDocumentListResponseSchema>;
type Row = List['items'][number];

const UNFINISHED_STATUSES: ReadonlyArray<Row['status']> = [
  'queued',
  'processing',
  'needs_resolution',
];

/**
 * «Живой» ли документ — то есть ждём ли мы, что сервер сам изменит его статус.
 *
 * Пара (статус, код), а не один статус: заглушка висит в needs_resolution до
 * ручного разбора, и по одному статусу опрос на 4 секунды не выключился бы
 * никогда. Автоматических попыток по ней больше не будет — распознавать нечем.
 */
function isUnfinished(row: Pick<Row, 'status' | 'parseErrorCode'>): boolean {
  if (isStubDocument(row)) return false;
  return UNFINISHED_STATUSES.includes(row.status);
}

type KindFilter = 'all' | 'upd' | 'request';

/**
 * Цвет/подпись типа документа. Накладные двух форм (ТН-2116 и ОС-2)
 * показываются одним тегом «Накладная» — для пользователя это
 * семантически один тип источника (см. WaybillUploadModal и
 * waybill-batch.parser.ts на бэке).
 */
// Склонение «документ» под число для bulk-confirm:
// 1 документ / 2-4 документа / 5+ документов.
function pluralizeDoc(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'документов';
  if (last === 1) return 'документ';
  if (last >= 2 && last <= 4) return 'документа';
  return 'документов';
}

/**
 * Откуда документ взялся. Раньше в карточке печаталось сырое значение
 * (`manual_pdf`) — для пользователя это ничего не значило, а с приходом почты
 * различать источник стало нужно: у почтовых документов не заполнен подрядчик.
 */
function originLabel(origin: string, fromSupplierPortal?: boolean): string {
  // Публичная загрузка не отдельный origin (он уходит мобильному клиенту и
  // менять его enum рискованно) — признак живёт рядом, на событии приёма.
  if (fromSupplierPortal) return 'От поставщика (по ссылке)';
  switch (origin) {
    case 'mail':
      return 'Из почты';
    case 'edo_diadoc':
      return 'ЭДО Диадок';
    case 'manual_xml':
      return 'Загружен вручную (XML)';
    default:
      return 'Загружен вручную';
  }
}

function KindTag({ kind }: { kind: Row['kind'] }) {
  if (kind === 'upd') return <Tag color="blue">УПД</Tag>;
  if (kind === 'transport_waybill' || kind === 'os2_transfer') {
    return <Tag color="purple">Накладная</Tag>;
  }
  return <Tag color="gold">Заявка</Tag>;
}

/**
 * Файл, по которому документ заведён пустым — только чтобы он не исчез из виду;
 * ни номера, ни позиций в нём нет, а тип неизвестен, и «УПД» в колонке «Тип»
 * было бы враньём.
 *
 * Накладной, которую не смог прочитать парсер, здесь нет: её тип известен из
 * классификации, и тег «Накладная» для неё правдив.
 */
function isUnrecognized(row: Pick<Row, 'parseErrorCode'>): boolean {
  // По коду, а не по статусу: закрытый вручную файл уходит в архив, но код при
  // нём остаётся (по нему запись не уезжает на планшет и не попадает в
  // «Ожидаемые») — тип у неё так и остался неизвестным.
  return (
    row.parseErrorCode === 'unrecognized_type' ||
    row.parseErrorCode === 'supplementary' ||
    row.parseErrorCode === 'not_processed'
  );
}

/** Подсказка под тегом «не распознано»: у каждой заглушки своя причина. */
function stubHint(code: Row['parseErrorCode']): string {
  if (code === 'no_waybill_found') {
    return 'Накладную прочитать не удалось — ни ТН, ни ОС-2 не распознаны. Откройте файл и разберите вручную';
  }
  if (code === 'not_processed') {
    return 'Файл принят, но распознать его не удалось. Откройте файл и разберите вручную';
  }
  if (code === 'recovery_exhausted') {
    return 'Распознавание не завершилось за отведённые попытки. Файл на месте — откройте его и разберите вручную';
  }
  return 'Тип документа определить не удалось — откройте файл и разберите вручную';
}

function StatusTag({
  row,
  onResolve,
  onManualResolve,
}: {
  row: Row;
  onResolve?: (r: Row) => void;
  onManualResolve?: (r: Row) => void;
}) {
  // Принятый файл, по которому документа ещё нет. «не загружен» — отдельный
  // случай: объекта в хранилище не существует, и ждать тут нечего, нужна
  // повторная отправка. Обычный ожидающий файл идёт ниже общей веткой
  // 'queued' — он и правда стоит в очереди на распознавание.
  if (isPendingRow(row) && pendingStateOf(row) === 'not_stored') {
    return (
      <Tooltip title="Файл принят формой, но не сохранился в хранилище. Остальные файлы поставки приняты — попросите отправить этот ещё раз.">
        <Tag color="red">не загружен</Tag>
      </Tooltip>
    );
  }
  // onResolve не передан (роль contractor) → resolve-кнопки скрыты: дозаполнение
  // и разрешение дубликатов — write-операции, подрядчику недоступны.
  // Derived-статус: если parsed, но не заполнены получатель/объект/дата
  // поставки — показываем «Черновик» вместо «обработано». UI сразу
  // подскажет пользователю, что документ требует дозаполнения.
  const display = getDocumentDisplayStatus({
    status: row.status,
    direction: row.direction,
    contractorId: row.contractorId,
    recipientId: row.recipientId,
    recipientMolId: row.recipientMolId,
    expectedDate: row.expectedDate,
    siteId: row.siteId,
  });
  if (display === 'draft') {
    return (
      <Tooltip title="Не заполнены: получатель / объект / дата поставки. Откройте документ и дозаполните.">
        <Tag color="gold">Черновик</Tag>
      </Tooltip>
    );
  }
  switch (row.status) {
    case 'queued':
      return <Tag color="blue">в очереди</Tag>;
    case 'processing':
      return (
        <Tag color="processing" icon={<LoadingOutlined />}>
          распознаётся
        </Tag>
      );
    case 'parsed': {
      // Процент LLM-confidence в UI скрыт по запросу пользователя —
      // значение llmConfidence остаётся в БД/контрактах, при необходимости
      // его можно вернуть в столбец. Warning-иконку для несовпадения сумм
      // оставляем — это сигнал к действию.
      const hasMismatch = row.validation?.hasMismatch === true;
      // Подозрения — отдельный сигнал от расхождения сумм: арифметика сошлась,
      // но числа выглядят подставленными (сумма равна количеству, цена ровно 1,
      // грузополучатель повторяет покупателя без подтверждения в бланке). Без
      // значка в списке их видно только внутри карточки, то есть очереди
      // ручной проверки не возникает вовсе.
      const warnings = row.validation?.warnings ?? [];
      return (
        <Space size={4} align="center">
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            обработано
          </Tag>
          {hasMismatch && (
            <Tooltip title="Сумма по позициям не сходится с шапкой">
              <WarningOutlined style={{ color: '#fa8c16', fontSize: 12 }} />
            </Tooltip>
          )}
          {!hasMismatch && warnings.length > 0 && (
            <Tooltip title="Требует внимания — откройте документ">
              <QuestionCircleOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
            </Tooltip>
          )}
        </Space>
      );
    }
    case 'parse_failed': {
      const msg =
        (row.parseErrorDetails as { message?: string } | null)?.message ??
        row.parseErrorCode ??
        'ошибка';
      return (
        <Tooltip title={msg}>
          <Tag color="red" icon={<ExclamationCircleOutlined />}>
            ошибка
          </Tag>
        </Tooltip>
      );
    }
    case 'archived':
      // Сопроводительный документ (сертификат, паспорт качества, проформа, файл
      // из зоны «Дополнительные») не «убран из работы», а изначально в ней не
      // участвует: реквизитов в нём нет, разбирать нечего. Отдельный тег, чтобы
      // менеджер не искал, кто и зачем отправил документ в архив.
      if (row.parseErrorCode === 'supplementary') {
        return (
          <Tooltip title="Сопроводительный документ — распознавание не требуется, файл доступен в карточке">
            <Tag color="default">доп. документ</Tag>
          </Tooltip>
        );
      }
      return <Tag>архив</Tag>;
    case 'needs_resolution':
      if (isActionableStub(row)) {
        // Автоматических попыток больше не будет: и классификатор, и vision уже
        // отказались. Строка живёт, пока человек не откроет файл и не закроет
        // вопрос. «Разобрано» без реквизитов уводит документ в архив (файл
        // остаётся доступным), с введёнными реквизитами — в «обработано».
        return (
          // wrap={false} во всех составных статусах: с переносом тег и
          // действие вставали в две строки и высота строки таблицы скакала.
          <Space size={4} wrap={false}>
            <Tooltip title={stubHint(row.parseErrorCode)}>
              <Tag color="default" style={{ marginInlineEnd: 0 }}>
                не распознано
              </Tag>
            </Tooltip>
            {onManualResolve && (
              <Tooltip title="Закрыть вопрос по файлу: он уйдёт в архив, но останется доступным">
                <Button
                  size="small"
                  type="link"
                  // Без собственных отступов: ссылка-действие стоит вплотную к
                  // тегу, и пара целиком помещается в ширину колонки «Статус».
                  style={{ padding: 0, height: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onManualResolve(row);
                  }}
                >
                  разобрано
                </Button>
              </Tooltip>
            )}
          </Space>
        );
      }
      if (row.parseErrorCode === 'duplicate_upd') {
        return (
          <Space size={4} wrap={false}>
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              дубликат
            </Tag>
            {onResolve && (
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: 'auto' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(row);
                }}
              >
                разрешить
              </Button>
            )}
          </Space>
        );
      }
      if (row.parseErrorCode === 'partial_parse') {
        // Шапка распознана, но позиции/итого не вытащены — типично для
        // xlsx-УПД на Шаге 2a парсера. Пользователь дозаполнит вручную.
        const missing = (row.parseErrorDetails as { missing?: string[] } | null)?.missing;
        return (
          <Space size={4} wrap={false}>
            <Tooltip
              title={
                missing && missing.length
                  ? `Не распознаны: ${missing.join(', ')}`
                  : 'Документ распознан частично — дополните данные вручную'
              }
            >
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                распознано частично
              </Tag>
            </Tooltip>
            {onResolve && (
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: 'auto' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(row);
                }}
              >
                дополнить
              </Button>
            )}
          </Space>
        );
      }
      return (
        <Space size={4} wrap={false}>
          <Tooltip
            title={
              (row.parseErrorDetails as { failedChecks?: unknown[] } | null)?.failedChecks
                ? 'Суммы по позициям не сходятся с шапкой документа'
                : undefined
            }
          >
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
              суммы не сходятся
            </Tag>
          </Tooltip>
          {onResolve && (
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: 'auto' }}
              onClick={(e) => {
                e.stopPropagation();
                onResolve(row);
              }}
            >
              проверить
            </Button>
          )}
        </Space>
      );
    default:
      return <Tag>{row.status}</Tag>;
  }
}

// Поля серверной сортировки — те же, что понимает GET /source-documents.
// Ключ колонки таблицы отличается у сторон документа (buyer/consignee/supplier),
// поэтому рядом лежит перевод.
const SORT_FIELDS = [
  'kind',
  'status',
  'docNumber',
  'docDate',
  'expectedDate',
  'siteName',
  'buyerName',
  'consigneeName',
  'supplierName',
  'vatSum',
  'totalSum',
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const COLUMN_TO_SORT_FIELD: Record<string, SortField> = {
  kind: 'kind',
  status: 'status',
  docNumber: 'docNumber',
  docDate: 'docDate',
  expectedDate: 'expectedDate',
  siteName: 'siteName',
  buyer: 'buyerName',
  consignee: 'consigneeName',
  supplier: 'supplierName',
  vatSum: 'vatSum',
  totalSum: 'totalSum',
};

export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Подрядчик: read-only + справочники закрыты. Скрываем write-UI, не грузим
  // справочные запросы; колонки уже читают имена из DTO документа.
  const isContractor = useAuthStore((s) => s.user?.role) === 'contractor';
  // Действия раздела «Документы» — по матрице, а не по роли: их можно выдать
  // (в отличие от операций и фото, где ограничение роли живёт в скоупе данных
  // и мобильном клиенте). При дефолтах значения совпадают с прежними:
  // create/edit/delete у documents.list есть только у manager.
  const { can: canDo } = usePermissions();
  const canCreateDocs = canDo('documents.list', 'create');
  const canDeleteDocs = canDo('documents.list', 'delete');
  // Повторное распознавание — отдельное действие матрицы: правка полей и
  // повторный прогон через модель различаются и по цене, и по последствиям.
  const canReparseDocs = canDo('documents.list', 'reparse');
  // direction/kind/q + контрагенты/объект — всё хранится в URL, чтобы фильтры
  // переживали F5 и поддерживали share-able ссылки.
  const direction: SourceDirection =
    params.get('direction') === 'outbound' ? 'outbound' : 'inbound';
  const kind: KindFilter = (() => {
    const k = params.get('kind');
    if (k === 'upd' || k === 'request') return k;
    return 'all';
  })();

  const filters: ListFiltersValue = {
    contractorIds: parseCsvIds(params.get('contractor')),
    supplierIds: parseCsvIds(params.get('supplier')),
    siteIds: parseCsvIds(params.get('site')),
    q: params.get('q') ?? '',
  };
  // Очередь ручной проверки: документы с подозрениями (validation.warnings).
  // В URL — чтобы ссылкой на очередь можно было поделиться и чтобы фильтр
  // пережил F5, как остальные.
  const needsAttention = params.get('attention') === '1';

  // Страница, сортировка и диапазоны дат — тоже в адресе и тоже на сервере.
  // Клиентских сортировок и колоночных фильтров в этой таблице больше нет: с
  // серверной страницей они работали бы по 50 загруженным строкам и врали бы,
  // выдавая «последнее по алфавиту» из первой страницы.
  const PAGE_SIZE = 50;
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const sortField = SORT_FIELDS.includes((params.get('sort') ?? '') as SortField)
    ? (params.get('sort') as SortField)
    : null;
  const sortOrder: 'asc' | 'desc' = params.get('order') === 'asc' ? 'asc' : 'desc';
  // Дип-линк «Расхождение сумм» из «Статистики»: документы, где разбор нашёл
  // несходящуюся арифметику. Своего контрола у фильтра нет — он показывается
  // чипом и оттуда же снимается.
  const mismatch = params.get('mismatch') === '1';
  const docDateFrom = params.get('docFrom');
  const docDateTo = params.get('docTo');
  const expectedFrom = params.get('expFrom');
  const expectedTo = params.get('expTo');

  // patchSearchParams различает «не трогать» (undefined) и «снять» (null/''):
  // фильтры шлют частичный патч, и раньше ключи со значением undefined
  // доходили до delete — ввод номера документа снимал объект и контрагентов.
  const updateParams = (patch: SearchParamsPatch) => {
    setParams(patchSearchParams(params, patch), { replace: true });
  };
  const updateFilters = (patch: Partial<ListFiltersValue>) => {
    updateParams({
      contractor: 'contractorIds' in patch ? toCsvIds(patch.contractorIds) : undefined,
      supplier: 'supplierIds' in patch ? toCsvIds(patch.supplierIds) : undefined,
      site: 'siteIds' in patch ? toCsvIds(patch.siteIds) : undefined,
      q: 'q' in patch ? patch.q : undefined,
      // Новый фильтр — новая выдача: со старой страницы можно попасть в пустоту.
      page: null,
    });
  };

  // «Липкие» фильтры между разделами: если URL пустой при заходе, поднимаем
  // Подрядчика/Поставщика/Объект из global store. Любое изменение здесь
  // тоже отзеркаливается обратно в store. Поиск/направление остаются
  // локальными для этого раздела.
  useSyncGlobalFilters({
    current: {
      contractorIds: filters.contractorIds,
      supplierIds: filters.supplierIds,
      siteIds: filters.siteIds,
    },
    apply: (next) =>
      updateFilters({
        contractorIds: next.contractorIds,
        supplierIds: next.supplierIds,
        siteIds: next.siteIds,
      }),
  });

  // Условия выборки — один объект на все три запроса страницы: список,
  // счётчик «Требуют внимания» и выгрузку. Пока каждый собирал query-строку
  // сам, список тихо растерял половину параметров (даты, сортировку, страницу,
  // mismatch) — фильтры «работали» только в адресе. См. listParams.ts.
  const listParamsInput: DocumentListParamsInput = {
    direction,
    kind,
    q: filters.q,
    contractorIds: filters.contractorIds,
    supplierIds: filters.supplierIds,
    siteIds: filters.siteIds,
    needsAttention,
    mismatch,
    docDateFrom,
    docDateTo,
    expectedDateFrom: expectedFrom,
    expectedDateTo: expectedTo,
    sort: sortField,
    order: sortOrder,
    page,
    pageSize: PAGE_SIZE,
  };

  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [twModalOpen, setTwModalOpen] = useState(false);
  const [docsModalOpen, setDocsModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Скачивание xlsx-выгрузки с теми же фильтрами, что и в UI: бэк сам
  // фильтрует по contractor/supplier/site и q. Имя файла берём из
  // Content-Disposition (фоллбек — direction+дата).
  async function handleExportExcel() {
    try {
      setExporting(true);
      // Ровно те же условия и тот же порядок, что у списка: файл обязан
      // повторять экран. Окна страницы в выгрузке нет — это весь набор.
      const qs = buildDocumentListParams(listParamsInput, 'export');
      const { blob, filename } = await apiDownload(
        `/source-documents/export.xlsx?${qs.toString()}`,
      );
      const fallback = `documents-${direction}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || fallback;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // setTimeout: revoke сразу после click() ломает скачивание в Safari.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();

  // Фильтры уходят на сервер: раньше подрядчик/поставщик/объект отсеивались в
  // браузере поверх лимита, а сравнение с operational supplier_id (у современных
  // УПД он пуст — поставщик в supplier_directory_id) не находило вообще ничего.
  // Все параметры входят в queryKey, иначе смена фильтра читала бы чужой кэш.
  const listQuery = {
    direction,
    kind,
    q: filters.q.trim(),
    contractor: toCsvIds(filters.contractorIds),
    supplier: toCsvIds(filters.supplierIds),
    site: toCsvIds(filters.siteIds),
    attention: needsAttention,
    mismatch,
    docDateFrom,
    docDateTo,
    expectedFrom,
    expectedTo,
    sort: sortField,
    order: sortOrder,
    page,
  };
  const list = useQuery({
    queryKey: ['source-documents', listQuery],
    queryFn: () => {
      // Страница, а не «весь набор»: раньше тянулись первые 2000 документов, и
      // всё, что за этой границей, было недостижимо ни фильтром, ни сортировкой
      // (в приёмке их уже больше двух тысяч). Все условия, порядок и окно
      // страницы собирает общий билдер — см. listParams.ts.
      const qs = buildDocumentListParams(listParamsInput, 'list');
      return api.get<List>(`/source-documents?${qs.toString()}`);
    },
    // При смене вкладки/фильтра показываем прошлый список, а новые данные
    // подтягиваются «поверх» — без прыжка к Empty и спиннера.
    placeholderData: keepPreviousData,
    // Поллинг: 4с, пока в выдаче есть «живые» документы (queued/processing/
    // needs_resolution) — чтобы статус быстро дошёл до «обработано». Когда всё
    // обработано — поллинг НЕ выключаем полностью, а замедляем до 20с: иначе
    // документы, созданные/распознанные асинхронно уже ПОСЛЕ остановки (router
    // создаёт строки с задержкой, parse идёт в фоне), не появлялись бы без
    // ручного обновления страницы (Ctrl+R).
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const hasUnfinished = items.some(isUnfinished);
      return hasUnfinished ? 4000 : 20000;
    },
    refetchIntervalInBackground: false,
  });

  // Опции «Подрядчик»/«Поставщик» — из справочников заказчика, как в
  // «Операциях» и «Отгрузке». Прежде здесь стояли операционные counterparties:
  // список поставщиков расходился со вкладкой «Справочники → Поставщики», а
  // выбранный id не совпадал с тем, что кладут в общий стор другие разделы, —
  // после перехода между разделами таблица пустела.
  const customerCounterpartiesQuery = useQuery({
    queryKey: ['customer-counterparties', 'all'],
    queryFn: () =>
      api.get<{ items: CustomerCounterparty[]; total: number }>(
        '/customer-counterparties?limit=5000',
      ),
    enabled: !isContractor,
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', 'all'],
    queryFn: () => api.get<{ items: Supplier[]; total: number }>('/suppliers?limit=5000'),
    enabled: !isContractor,
  });
  const sitesQuery = useQuery({
    queryKey: ['sites', { activeOnly: true, limit: 200 }],
    queryFn: () => api.get<{ items: Site[]; total: number }>('/sites?activeOnly=true&limit=200'),
    enabled: !isContractor,
  });
  const contractorOptions = useMemo(
    () =>
      (customerCounterpartiesQuery.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    [customerCounterpartiesQuery.data],
  );
  const supplierOptions = useMemo(
    () => (suppliersQuery.data?.items ?? []).map((s) => ({ value: s.id, label: s.name })),
    [suppliersQuery.data],
  );

  // Лёгкие count-запросы для вкладок «Приёмка / Отгрузка». limit=1 — серверу
  // достаточно для возврата total. Запросы независимы от текущего direction,
  // чтобы счётчики были стабильны при переключении.
  const inboundCountQuery = useQuery({
    queryKey: ['source-documents', 'count', 'inbound'],
    queryFn: () => api.get<{ total: number }>('/source-documents?direction=inbound&limit=1'),
  });
  const outboundCountQuery = useQuery({
    queryKey: ['source-documents', 'count', 'outbound'],
    queryFn: () => api.get<{ total: number }>('/source-documents?direction=outbound&limit=1'),
  });
  // Счётчик вкладки «Без документов»: сама вкладка есть давно, но пока в ней не
  // видно числа, туда никто не заглядывает — а именно там оседают файлы, из
  // которых документа не вышло. Эндпоинт admin/manager-only, подрядчику вкладки
  // нет вовсе.
  const extraOnlyCountQuery = useQuery({
    queryKey: ['source-bundles', 'extra-only', 'count'],
    queryFn: () => api.get<{ total: number }>('/source-bundles/extra-only?limit=1'),
    enabled: !isContractor,
  });

  // Сводка почтового канала. Пока ящик с документами не заведён, вкладка
  // «Разбор почты» не показывается — страница выглядит ровно как раньше.
  // Подрядчику её нет никогда: чужие письма ему видеть нельзя.
  const mailSummaryQuery = useQuery({
    queryKey: ['mail-review-summary'],
    queryFn: () => api.get<{ pending: number; configured: boolean }>('/mail/review/summary'),
    enabled: !isContractor,
    staleTime: 5 * 60_000,
  });

  // Оптимистическое удаление: строка мгновенно исчезает из таблицы, тост
  // показывается сразу, а DELETE-запрос летит в фоне. При ошибке (например
  // has_references) откатываем кэш через snapshot и показываем тост ошибки.
  const del = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/source-documents/${id}`),
    // Сетевые сбои и 5xx — ретраим до 2 раз; 4xx (404, 409 has_references) —
    // бизнес-ошибки, ретрай не имеет смысла.
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return true;
    },
    onMutate: async (id: string) => {
      // Очищаем индикатор предыдущей ошибки для этой записи (повторная попытка).
      setDeleteErrors((prev) => {
        if (!(id in prev)) return prev;
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });

      // Отменяем активные refetch, иначе они затрут оптимистическое изменение.
      await qc.cancelQueries({ queryKey: ['source-documents'] });

      // Snapshot всех закэшированных списков (вариантов по direction/kind/...)
      // для возможного rollback.
      const snapshots = qc.getQueriesData<List>({ queryKey: ['source-documents'] });

      // Убираем удаляемую запись из всех закэшированных списков.
      qc.setQueriesData<List>({ queryKey: ['source-documents'] }, (old) => {
        if (!old || !Array.isArray(old.items)) return old;
        return { ...old, items: old.items.filter((x) => x.id !== id) };
      });

      // Если открыта модалка детали этого документа — закрываем.
      if (selectedId === id) setSelectedId(null);

      message.success('УПД удалён');

      return { snapshots };
    },
    onError: (err: Error, id, ctx) => {
      // Откат оптимистического изменения.
      const snapshots = (
        ctx as { snapshots?: Array<[readonly unknown[], List | undefined]> } | undefined
      )?.snapshots;
      if (snapshots) {
        for (const [key, value] of snapshots) {
          qc.setQueryData(key, value);
        }
      }
      // Маркер ошибки на вернувшейся строке (виден до повторной попытки).
      setDeleteErrors((prev) => ({ ...prev, [id]: err.message }));
      message.error(err.message);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    },
  });

  // «Разобрано вручную» для нераспознанного файла: документ уходит из
  // needs_resolution в «обработано», а в реестре входных файлов отмечается, кто
  // и когда закрыл вопрос. Без этого действия строка висела бы вечно и держала
  // опрос списка на 4 секундах.
  const resolveManually = useMutation({
    mutationFn: (id: string) =>
      api.patch<{ id: string; status: string }>(`/source-documents/${id}`, {
        resolveManually: true,
      }),
    onSuccess: (res: { status?: string }) => {
      message.success(
        res.status === 'parsed' ? 'Документ помечен обработанным' : 'Файл убран в архив',
      );
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  // Сервер уже применил все фильтры, включая «Требуют внимания», — второй раз
  // отсеивать нечего. Прежняя клиентская копия к тому же сравнивала поставщика
  // с полем, которого у современных УПД нет.
  const filteredItems = list.data?.items ?? [];

  // Сколько документов ждут ручной проверки — по тем же фильтрам, что и список,
  // но всегда с needsAttention: иначе после нажатия кнопки счётчик схлопнулся бы
  // до числа показанных строк и перестал бы что-либо значить. Отдельный запрос
  // с limit=1 — нужен только total, и считается он по ВСЕЙ выборке, а не по
  // загруженной странице.
  const attentionQuery = useQuery({
    // Даты и mismatch входят в ключ наравне с остальными фильтрами: без них
    // при выбранном диапазоне кэш отдавал бы число из другой выборки, и на
    // кнопке стояло бы больше, чем покажет переход по ней.
    queryKey: [
      'source-documents',
      'attention-count',
      {
        direction,
        kind,
        q: listQuery.q,
        contractor: listQuery.contractor,
        supplier: listQuery.supplier,
        site: listQuery.site,
        mismatch,
        docDateFrom,
        docDateTo,
        expectedFrom,
        expectedTo,
      },
    ],
    queryFn: () => {
      const qs = buildDocumentListParams(listParamsInput, 'attention');
      return api.get<{ total: number }>(`/source-documents?${qs.toString()}`);
    },
    placeholderData: keepPreviousData,
  });
  const attentionCount = attentionQuery.data?.total ?? 0;

  // Принятые файлы, до которых разбор ещё не дошёл, — обычные строки списка.
  // Своей таблицы им заводить нельзя: вторая шапка колонок читается как
  // чужеродный блок, а любой блок над списком выталкивает страницу за пределы
  // экрана (таблица считает прокрутку от 100vh) и добавляет второй скроллбар.
  //
  // Сервер отдаёт их только на первой странице и только менеджеру с админом,
  // поэтому здесь достаточно взять что дали.
  const pendingRows = useMemo(
    () => (list.data?.pendingFiles ?? []).map(pendingAsRow),
    [list.data?.pendingFiles],
  );

  // Документы одной машины — подряд и с общей цветовой меткой. Кластеризация
  // стабильная: место кластера задаёт первый его документ, поэтому порядок
  // списка (по дате) сохраняется. Явная сортировка по колонке сильнее — antd
  // применяет свой sorter после нас, и строки машины могут разойтись; метка
  // при этом остаётся, и машина по-прежнему узнаётся.
  //
  // Ожидающие файлы идут в том же потоке строк, что и документы: файл встаёт
  // рядом с уже разобранными документами своей поставки. Сервер отдаёт их из
  // того же окна limit/offset, поэтому строк на странице ровно pageSize и
  // таблица ничего не срезает.
  const groupedItems = useMemo(
    () => clusterRowsByGroup([...pendingRows, ...filteredItems]),
    [pendingRows, filteredItems],
  );

  // Префетч позиций — фоном после рендера списка. Клик «+» раскрывает
  // строку, дёргать сеть в этот момент не приходится: ExpandedSource-
  // DocumentItems читает тот же queryKey из кэша react-query.
  usePrefetchSourceDocumentDetails(useMemo(() => filteredItems.map((r) => r.id), [filteredItems]));

  // Массовое удаление: чекбоксы слева, bulk action bar поверх таблицы.
  // Выбор сбрасывается при смене вкладки direction (через зависимость в
  // queryKey list — он получит другой набор items).
  // Раскрытие строк (показ позиций документа под шапкой). Lazy fetch
  // через ExpandedSourceDocumentItems → useQuery, кеш react-query.
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const toggleExpand = (id: string) =>
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const bulk = useBulkSelection<Row>((r) => r.id);
  const bulkDel = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<SourceDocumentBulkDeleteResponse>('/source-documents/bulk-delete', { ids }),
    onSuccess: (res) => {
      bulk.clear();
      if (res.deleted.length > 0) message.success(`Удалено: ${res.deleted.length}`);
      if (res.skipped.length > 0) {
        const refsCount = res.skipped.filter((s) => s.reason === 'has_references').length;
        const otherCount = res.skipped.length - refsCount;
        const parts: string[] = [];
        if (refsCount > 0) parts.push(`${refsCount} — есть привязки к приёмке/отгрузке`);
        if (otherCount > 0) parts.push(`${otherCount} — другая причина`);
        message.warning(`Пропущено ${res.skipped.length}: ${parts.join('; ')}`);
      }
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
    },
    onError: (err: Error) => {
      message.error(err.message);
    },
  });

  // Повторное распознавание: документ уходит обратно в очередь и разбирается
  // заново тем же путём, каким появился. Исходный файл не трогается — меняются
  // только распознанные данные, и при неудаче документ возвращается в прежний
  // вид (сервер держит снимок).
  const reparse = useMutation({
    mutationFn: (id: string) =>
      api.post<SourceReparseResponse>(`/source-documents/${id}/reparse`, {}),
    onSuccess: (_res, id) => {
      message.success('Документ отправлен на повторное распознавание');
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const recover = useMutation({
    mutationFn: (id: string) =>
      api.post<SourceRecoverResponse>(`/source-documents/${id}/recover`, {}),
    onSuccess: (res, id) => {
      if (res.outcome === 'terminalized') {
        message.warning('Автоматические попытки исчерпаны — документ требует решения');
      } else {
        message.success('Распознавание восстановлено');
      }
      void qc.invalidateQueries({ queryKey: ['source-documents'] });
      void qc.invalidateQueries({ queryKey: ['source-document', id] });
    },
    onError: (err: Error) => message.error(err.message),
  });

  const renderReparseButton = (r: Row) => {
    if (!canReparseDocs) return null;
    const busy = r.status === 'queued' || r.status === 'processing';
    if (busy) {
      const recoverable =
        r.workHealth === 'missing' || r.workHealth === 'terminal' || r.workHealth === 'overdue';
      if (!recoverable) {
        const title =
          r.workHealth === 'unknown'
            ? 'Не удалось проверить состояние очереди'
            : 'Распознавание выполняется';
        return (
          <Button size="small" shape="circle" icon={<ReloadOutlined />} disabled title={title} />
        );
      }
      return (
        <Popconfirm
          title="Восстановить распознавание?"
          description="Сервер создаст новую защищённую попытку или зафиксирует видимый итог, если лимит исчерпан."
          okText="Восстановить"
          cancelText="Отмена"
          onConfirm={() => recover.mutate(r.id)}
        >
          <Button
            size="small"
            shape="circle"
            danger
            icon={<ReloadOutlined />}
            loading={recover.isPending}
            title="Восстановить распознавание"
          />
        </Popconfirm>
      );
    }
    return (
      <Popconfirm
        title="Распознать документ заново?"
        description="Файл сохранится, но текущие распознанные данные заменятся, а точные связи строк приёмки с позициями документа сбросятся."
        okText="Распознать"
        cancelText="Отмена"
        onConfirm={() => reparse.mutate(r.id)}
      >
        <Button
          size="small"
          shape="circle"
          icon={<ReloadOutlined />}
          disabled={reparse.isPending}
          title="Распознать повторно"
        />
      </Popconfirm>
    );
  };

  const renderDeleteButton = (r: Row) => {
    // Право «Удалять» на странице «Документы»: у подрядчика его нет по
    // умолчанию, но администратор может выдать.
    if (!canDeleteDocs) return null;
    const errMsg = deleteErrors[r.id];
    return (
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        {errMsg && (
          <Tooltip title={errMsg}>
            <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
          </Tooltip>
        )}
        <Popconfirm
          title="Удалить УПД?"
          description="Документ, его позиции и оригинальный файл будут удалены безвозвратно."
          okText="Да, удалить"
          cancelText="Нет"
          okButtonProps={{ danger: true }}
          onConfirm={() => del.mutate(r.id)}
        >
          <Button danger size="small" shape="circle" icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    );
  };

  const renderDocNumber = (v: string | null, r: Row) => {
    if (v) return v;
    // Номера нет ни у документа в работе, ни у заглушки — и во втором случае
    // его не появится вовсе. Без имени файла такие строки превращаются в пачку
    // одинаковых прочерков, где не отличить сертификат от нечитаемой накладной,
    // а именно по имени менеджер их и ищет.
    const showFilename = r.status === 'queued' || r.status === 'processing' || isStubDocument(r);
    if (showFilename && r.originalFilename) {
      return (
        <Typography.Text type="secondary" italic>
          {r.originalFilename}
        </Typography.Text>
      );
    }
    return '—';
  };

  // Сортировка — серверная: колонке достаточно знать, активна ли она сейчас.
  const sortProps = (columnKey: string) => ({
    sorter: true,
    sortOrder:
      sortField && COLUMN_TO_SORT_FIELD[columnKey] === sortField
        ? ((sortOrder === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend')
        : null,
  });

  // Смена страницы, сортировки или колоночного фильтра дат — всё это уходит в
  // адрес, а оттуда в запрос. Выбор строк сбрасываем: он относился к прежней
  // выдаче, и «Удалить выбранные» отправило бы id, которых на экране нет.
  const handleTableChange: NonNullable<TableProps<Row>['onChange']> = (
    tablePagination,
    tableFilters,
    tableSorter,
  ) => {
    const single = Array.isArray(tableSorter) ? tableSorter[0] : tableSorter;
    const columnKey = single && single.order ? String(single.columnKey ?? '') : '';
    const field = COLUMN_TO_SORT_FIELD[columnKey];
    const doc = parseDateRangeKey(tableFilters['docDate']?.[0] as string | undefined);
    const exp = parseDateRangeKey(tableFilters['expectedDate']?.[0] as string | undefined);
    const nextPage = tablePagination.current ?? 1;
    const filtersChanged =
      doc.from !== docDateFrom ||
      doc.to !== docDateTo ||
      exp.from !== expectedFrom ||
      exp.to !== expectedTo ||
      (field ?? null) !== sortField;
    updateParams({
      sort: field ?? null,
      order: field ? (single?.order === 'ascend' ? 'asc' : 'desc') : null,
      docFrom: doc.from,
      docTo: doc.to,
      expFrom: exp.from,
      expTo: exp.to,
      // Сортировка и фильтр меняют состав выдачи целиком — возвращаемся на
      // первую страницу, иначе можно оказаться на пустой седьмой.
      page: filtersChanged || nextPage <= 1 ? null : String(nextPage),
    });
    bulk.clear();
  };

  // Фильтры без своего контрола на панели — показываем чипами, иначе список
  // молча сужается и понять причину нельзя.
  const hiddenFilterChips: ActiveFilterChip[] = mismatch
    ? [
        {
          key: 'mismatch',
          label: 'Расхождение сумм',
          onClear: () => updateParams({ mismatch: null, page: null }),
        },
      ]
    : [];

  // Колонки списка. Вынесены в переменную: тем же набором рисуется блок
  // принятых файлов над таблицей.
  // Карточка строки для мобильного вида — общая у списка и у блока
  // принятых файлов над ним.
  const documentCardRender = (r: Row) => (
    <Card style={{ width: '100%' }} size="small">
      <Space direction="vertical" size={2} style={{ width: '100%', position: 'relative' }}>
        <Space size={4} wrap>
          {/* Принятый файл: тип ещё неизвестен — как и у нераспознанного. */}
          {isUnrecognized(r) || isPendingRow(r) ? <Tag>—</Tag> : <KindTag kind={r.kind} />}
          <StatusTag
            row={r}
            onResolve={isContractor ? undefined : (row) => setResolveId(row.id)}
            onManualResolve={isContractor ? undefined : (row) => resolveManually.mutate(row.id)}
          />
        </Space>
        <Typography.Text strong>
          {r.docNumber ?? (r.originalFilename ? r.originalFilename : '— без номера —')}
        </Typography.Text>
        <Typography.Text type="secondary">
          {r.docDate ?? '—'} · {formatDecimal(r.totalSum) || '—'} ₽
          {r.llmConfidence != null
            ? ` · уверенность ${Math.round(Number(r.llmConfidence) * 100)}%`
            : ''}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {r.siteName ?? '—'} · {shortenCounterpartyName(r.buyerName)} ·{' '}
          {shortenCounterpartyName(r.consigneeName)} · {shortenCounterpartyName(r.supplierName)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {originLabel(r.origin, r.fromSupplierPortal)}
        </Typography.Text>
        {!isPendingRow(r) && (
          <div
            style={{ position: 'absolute', top: 0, right: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {renderReparseButton(r)}
            {renderDeleteButton(r)}
          </div>
        )}
      </Space>
    </Card>
  );

  const documentColumns: TableProps<Row>['columns'] = [
    {
      title: 'Тип',
      dataIndex: 'kind',
      width: 150,
      // По частоте использования: УПД сверху, заявки в середине,
      // накладные (ТН + ОС-2) вместе внизу.
      ...sortProps('kind'),
      // Кнопка ± рядом с тегом — раскрывает/сворачивает позиции
      // под строкой. stopPropagation чтобы не сработал onRowClick.
      render: (_: unknown, r: Row) => {
        // Принятый файл: тип неизвестен, позиций нет — ни тега, ни
        // раскрытия. Прочерк здесь честнее «УПД», которого может и не
        // оказаться.
        if (isPendingRow(r)) {
          return (
            <Space size={4}>
              <Tag>—</Tag>
              <Tooltip title="Загружен поставщиком через публичную ссылку">
                <CloudUploadOutlined style={{ color: '#8c8c8c' }} />
              </Tooltip>
            </Space>
          );
        }
        const expanded = expandedIds.includes(r.id);
        return (
          <Space size={4}>
            <Button
              type="text"
              size="small"
              icon={expanded ? <MinusSquareOutlined /> : <PlusSquareOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(r.id);
              }}
            />
            {/* Тип «—»: файл распознать не удалось, и «УПД» здесь ввело
                      бы в заблуждение — реквизитов в документе нет. */}
            {isUnrecognized(r) ? <Tag>—</Tag> : <KindTag kind={r.kind} />}
            {/* Происхождение отмечаем только у почтовых: такой документ
                      пришёл от подрядчика письмом, а не загружен вручную. */}
            {r.origin === 'mail' && (
              <Tooltip title="Пришёл по почте от подрядчика">
                <MailOutlined style={{ color: '#8c8c8c' }} />
              </Tooltip>
            )}
            {/* Загружен самим поставщиком через публичную ссылку: у таких
                      документов подрядчик тоже не заполнен, а отправителя видно
                      в карточке. */}
            {r.fromSupplierPortal && (
              <Tooltip title="Загружен поставщиком через публичную ссылку">
                <CloudUploadOutlined style={{ color: '#8c8c8c' }} />
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      // Раньше шапка была двухстрочной «Статус / Уверенность» —
      // теперь процент в ячейке не рисуется, заголовок упростили
      // до одного «Статус».
      title: 'Статус',
      dataIndex: 'status',
      // Ширина под самую длинную пару «распознано частично» + «дополнить»
      // (~227px вместе с отступами ячейки). Уже — и общий ellipsis
      // обрезал бы действие, которое нужно нажимать.
      width: 260,
      // По «требует внимания»: активные вверху, архив внизу.
      ...sortProps('status'),
      render: (_: unknown, r: Row) => (
        <StatusTag
          row={r}
          onResolve={isContractor ? undefined : (row) => setResolveId(row.id)}
          onManualResolve={isContractor ? undefined : (row) => resolveManually.mutate(row.id)}
        />
      ),
    },
    {
      title: '№',
      dataIndex: 'docNumber',
      ...sortProps('docNumber'),
      render: renderDocNumber,
    },
    {
      title: 'Дата',
      dataIndex: 'docDate',
      // defaultSortOrder убран: иначе при каждой перемонтировке
      // (refresh / переход на другой раздел и обратно) сортировка
      // возвращалась принудительно. Сервер уже отдаёт документы по
      // parsed_at desc — свежие сверху без явной сортировки.
      ...sortProps('docDate'),
      ...serverDateRangeColumnFilter<Row>({ from: docDateFrom, to: docDateTo }),
      render: (v: string | null) => formatDateRu(v),
    },
    {
      title: 'Дата поставки',
      dataIndex: 'expectedDate',
      ...sortProps('expectedDate'),
      ...serverDateRangeColumnFilter<Row>({ from: expectedFrom, to: expectedTo }),
      render: (v: string | null) => formatDateRu(v),
    },
    {
      title: 'Объект',
      dataIndex: 'siteName',
      ...sortProps('siteName'),
      render: (v: string | null | undefined) => v ?? '—',
    },
    // Стороны документа — общий набор для всех таблиц с УПД,
    // см. shared/ui/documentPartyColumns.
    ...documentPartyColumns<Row>((r) => r, { sortProps }),
    {
      title: 'Сумма НДС',
      dataIndex: 'vatSum',
      ...sortProps('vatSum'),
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: 'Сумма',
      dataIndex: 'totalSum',
      ...sortProps('totalSum'),
      render: (v: string | null) => formatMoneyRu(v),
    },
    {
      title: '',
      key: 'actions',
      // Две круглые кнопки: повтор распознавания и удаление.
      width: 96,
      align: 'right' as const,
      onCell: () => ({
        onClick: (e: MouseEvent) => e.stopPropagation(),
      }),
      // Принятому файлу нечего повторять и нечего удалять: документа по
      // нему ещё нет, а сам файл живёт в реестре пакета.
      render: (_: unknown, r: Row) =>
        isPendingRow(r) ? null : (
          <Space size={4}>
            {renderReparseButton(r)}
            {renderDeleteButton(r)}
          </Space>
        ),
    },
  ];

  const mailSummary = mailSummaryQuery.data;
  const docsTabs: PageTabItem[] = [
    { key: 'inbound', label: 'Приёмка', count: inboundCountQuery.data?.total ?? null },
    { key: 'outbound', label: 'Отгрузка', count: outboundCountQuery.data?.total ?? null },
    // Показываем вкладку и когда ящик уже отключили, но письма в разборе
    // остались — иначе к ним не вернуться.
    ...(mailSummary && (mailSummary.configured || mailSummary.pending > 0)
      ? [{ key: 'mail', label: 'Разбор почты', count: mailSummary.pending }]
      : []),
    // Комплекты, из которых не создано ни одного документа: их файлы в списке
    // «Документы» не появятся вовсе, и это единственный путь к ним.
    ...(isContractor
      ? []
      : [
          {
            key: 'extra-only',
            label: 'Без документов',
            count: extraOnlyCountQuery.data?.total ?? null,
          },
        ]),
  ];

  return (
    // Fragment, а не обёрточный <div>: StickyPageHeader должен быть прямым
    // потомком Content (как на странице «Операции»). Лишний <div> вокруг
    // sticky-шапки ломал компенсацию верхнего отступа Content (marginTop:-12
    // в StickyPageHeader) → страница вырастала выше Content и появлялся ВТОРОЙ
    // (внешний) скролл поверх внутреннего скролла таблицы. Модалки ниже —
    // antd-порталы в body, на раскладку не влияют.
    <>
      <StickyPageHeader
        header={
          <>
            {/* Верхняя строка: заголовок + табы + (опционально) bulk-actions
                справа. Аналогично KppPage — таблица поднимается на одну строку. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <Typography.Title level={3} style={{ margin: 0 }}>
                  Документы
                </Typography.Title>
                <PageTabs
                  items={docsTabs}
                  activeKey={direction}
                  onChange={(k) => {
                    if (k === 'mail') {
                      navigate('/documents/mail');
                      return;
                    }
                    if (k === 'extra-only') {
                      navigate('/documents/extra-only');
                      return;
                    }
                    updateParams({ direction: k === 'outbound' ? 'outbound' : null, page: null });
                  }}
                />
              </div>
              {bulk.hasSelection && (
                <Space size={8} style={{ marginLeft: 'auto' }}>
                  <Typography.Text type="secondary">
                    Выбрано: <b>{bulk.selectedCount}</b>
                  </Typography.Text>
                  <Popconfirm
                    title={`Удалить ${bulk.selectedCount} ${pluralizeDoc(bulk.selectedCount)}?`}
                    okText="Удалить"
                    cancelText="Отмена"
                    okButtonProps={{ danger: true, loading: bulkDel.isPending }}
                    onConfirm={() => bulkDel.mutate(Array.from(bulk.selectedIds))}
                    placement="bottomRight"
                  >
                    <Button danger icon={<DeleteOutlined />} loading={bulkDel.isPending}>
                      Удалить выбранные
                    </Button>
                  </Popconfirm>
                  <Button onClick={bulk.clear} disabled={bulkDel.isPending}>
                    Снять выбор
                  </Button>
                </Space>
              )}
            </div>
            <ListFilters
              value={filters}
              onChange={updateFilters}
              // Подрядчик: только поиск (справочные фильтры не нужны и закрыты).
              fields={isContractor ? ['q'] : ['contractor', 'supplier', 'site', 'q']}
              contractorOptions={contractorOptions}
              supplierOptions={supplierOptions}
              sites={sitesQuery.data?.items ?? []}
              loading={
                customerCounterpartiesQuery.isLoading ||
                suppliersQuery.isLoading ||
                sitesQuery.isLoading
              }
              searchPlaceholder="Номер документа"
              extra={
                <Space size={8}>
                  {/* Очередь ручной проверки. Счётчик рядом с названием — иначе
                      непонятно, есть ли смысл нажимать: у большинства смен
                      подозрений нет вовсе. */}
                  <Button
                    type={needsAttention ? 'primary' : 'default'}
                    icon={<QuestionCircleOutlined />}
                    onClick={() =>
                      updateParams({ attention: needsAttention ? null : '1', page: null })
                    }
                  >
                    Требуют внимания
                    {attentionCount > 0 ? ` (${attentionCount})` : ''}
                  </Button>
                  {/* Загрузка документов — право «Создавать» на этой странице. */}
                  {canCreateDocs && (
                    <>
                      <Button type="primary" onClick={() => setDocsModalOpen(true)}>
                        Загрузить документы
                      </Button>
                      <Button onClick={() => setPdfModalOpen(true)}>Загрузить УПД</Button>
                      <Button onClick={() => setTwModalOpen(true)}>Загрузить накладные</Button>
                    </>
                  )}
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={handleExportExcel}
                    loading={exporting}
                  >
                    Экспорт Excel
                  </Button>
                </Space>
              }
            />
            <ActiveFilterChips items={hiddenFilterChips} />
          </>
        }
      >
        {/* Метка машины: документы одной загрузки помечены общей полосой слева.
          Правила строятся из GROUP_COLORS — списка, по которому считается и
          индекс цвета, поэтому палитра и классы не могут разойтись.
          box-shadow вместо border-left: border сдвигал бы содержимое ячейки и
          ломал выравнивание колонки «№» между строками. */}
        <style>
          {GROUP_COLORS.map(
            (color, i) =>
              `.matcheck-doc-group-${i} > td:first-child { box-shadow: inset 4px 0 0 ${color}; }`,
          ).join('\n')}
        </style>
        <ResponsiveTable<Row>
          items={groupedItems}
          loading={list.isLoading}
          rowKey="id"
          numbered
          // Сортировка списка серверная, поэтому по «№» не сортируем: этот
          // компаратор переставил бы только загруженную страницу, а сам клик
          // сбрасывал бы сортировку по колонке, выбранную пользователем.
          numberedSortable={false}
          // Колонок 14 (плюс чекбоксы при массовом выборе): четыре фиксированные,
          // десяти свободным нужно от ~110px. На 1024-1366px скроллим таблицу,
          // а не жмём колонки; на 1920px вид прежний. Три стороны документа с
          // появлением ИНН получили фиксированные 170px вместо ~110 свободных —
          // отсюда +150 к минимальной ширине.
          scrollX={1750}
          // Постраничная навигация серверная: total считает сервер по тем же
          // условиям, что и выдачу. Переключателя размера нет намеренно — он
          // менял бы страницу и оффсет одновременно.
          //
          // К числу документов прибавляем ожидающие файлы: они занимают строки
          // того же списка, и без них пагинатор недосчитался бы страниц.
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            // Страницы «плавающие»: сервер режет список по поставкам, поэтому
            // строк на странице около PAGE_SIZE, а не ровно столько, и вывести
            // их число из total нельзя. antd умеет считать страницы только как
            // total / pageSize — отдаём ему эквивалент, а человеку показываем
            // настоящее количество документов.
            total:
              (list.data?.pageCount ??
                // Ответ без pageCount (старая сборка API): считаем страницы
                // как раньше, иначе пагинатор схлопнулся бы в одну страницу.
                Math.max(
                  1,
                  Math.ceil(
                    ((list.data?.total ?? 0) + (list.data?.pendingTotal ?? 0)) / PAGE_SIZE,
                  ),
                )) * PAGE_SIZE,
            showSizeChanger: false,
            showTotal: () =>
              `Всего: ${(list.data?.total ?? 0) + (list.data?.pendingTotal ?? 0)}`,
          }}
          onChange={handleTableChange}
          numberedOffset={(page - 1) * PAGE_SIZE}
          rowSelection={
            isContractor
              ? undefined
              : {
                  ...bulk.selection,
                  // Массовое удаление относится к документам. У принятого файла
                  // документа ещё нет — удалять нечего, чекбокс неактивен.
                  getCheckboxProps: (r: Row) => ({ disabled: isPendingRow(r) }),
                }
          }
          // Цветная полоса слева у документов одной машины. Приглушённая:
          // строку со статусом «не распознано» она перекрикивать не должна.
          rowClassName={(r) => groupRowClass(documentGroupKey(r))}
          expandable={{
            // Свою колонку с иконкой не рендерим — ± живёт в столбце «Тип».
            showExpandColumn: false,
            expandedRowKeys: expandedIds,
            expandedRowRender: (r) => <ExpandedSourceDocumentItems id={r.id} kind={r.kind} withVat />,
          }}
          // Карточки у принятого файла не существует — открывать нечего.
          onRowClick={(r) => {
            if (isPendingRow(r)) return;
            setSelectedId(r.id);
          }}
          columns={documentColumns}
          cardRender={documentCardRender}
        />
      </StickyPageHeader>
      <UpdPdfUploadModal
        open={pdfModalOpen}
        direction={direction}
        onClose={() => setPdfModalOpen(false)}
      />
      <WaybillUploadModal
        open={twModalOpen}
        direction={direction}
        onClose={() => setTwModalOpen(false)}
      />
      <UploadDocumentsModal
        open={docsModalOpen}
        direction={direction}
        onClose={() => setDocsModalOpen(false)}
      />
      <SourceDocumentDetailModal
        id={selectedId}
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
      />
      <UpdResolveDuplicateModal
        id={resolveId}
        open={!!resolveId}
        onClose={() => setResolveId(null)}
      />
    </>
  );
}
