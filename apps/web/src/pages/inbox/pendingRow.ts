/**
 * Принятый файл, показанный ОБЫЧНОЙ строкой списка документов.
 *
 * Между приёмом файла и появлением документа лежит разбор: обычно секунды, при
 * забитой очереди — часы. Всё это время менеджер не мог отличить «поставщик не
 * присылал» от «прислал, но мы ещё не разобрали».
 *
 * Почему строкой того же списка, а не отдельным блоком. Отдельная таблица над
 * списком заводит вторую шапку колонок — визуально это чужеродный блок, хотя
 * речь о тех же документах поставки. Вдобавок список считает свою область
 * прокрутки от высоты экрана (`calc(100vh - …)` в ResponsiveTable), и любой
 * блок над ним выталкивает страницу за пределы вьюпорта, добавляя второй
 * скроллбар рядом с собственным скроллом таблицы.
 *
 * Строка при этом ничего нового в таблицу не приносит: у списка уже есть вид
 * «документ без номера» — имя файла курсивом в колонке «№» и тег в «Статусе»,
 * ровно так показываются нераспознанные. Ожидающий файл занимает то же место.
 */
import type { PendingFile, SourceDocumentListResponse } from '@matcheck/contracts';

type Row = SourceDocumentListResponse['items'][number];

/**
 * Префикс ключа такой строки.
 *
 * Он же признак «это не документ»: id настоящего документа — UUID, и спутать
 * их нельзя. React по этому ключу отличает строку файла от строки появившегося
 * по нему документа и не переиспользует DOM-узел с чужим состоянием.
 */
const PENDING_KEY_PREFIX = 'registry:';

export function isPendingRow(row: Pick<Row, 'id'>): boolean {
  return row.id.startsWith(PENDING_KEY_PREFIX);
}

/** Чем именно занят файл: ждёт разбора или вовсе не долетел до хранилища. */
export type PendingState = 'awaiting_processing' | 'not_stored';

const stateById = new Map<string, PendingState>();

export function pendingStateOf(row: Pick<Row, 'id'>): PendingState | null {
  return stateById.get(row.id) ?? null;
}

/**
 * Превращает принятый файл в строку, совместимую с таблицей документов.
 *
 * Статус `queued` не подделка, а правда: файл действительно стоит в очереди на
 * распознавание. Благодаря ему строка сама собой получает и синий тег «в
 * очереди», и имя файла курсивом в колонке «№» — оба вида уже реализованы для
 * документов в очереди, и дублировать их не нужно.
 *
 * Реквизиты, стороны и суммы остаются пустыми: колонки отдают «—» на null.
 */
export function pendingAsRow(file: PendingFile): Row {
  stateById.set(file.key, file.state);
  return {
    id: file.key,
    // Тип рисуется как «—» отдельной веткой: чем окажется файл, неизвестно, и
    // «УПД» здесь было бы просто неправдой.
    kind: 'upd',
    direction: 'inbound',
    status: 'queued',
    supplierId: null,
    recipientId: null,
    contractorId: null,
    recipientMolId: null,
    recipientSource: null,
    siteId: null,
    supplierName: null,
    contractorName: null,
    recipientName: null,
    recipientMolName: null,
    siteName: file.siteName,
    buyerId: null,
    buyerName: null,
    consigneeId: null,
    consigneeName: null,
    supplierInn: null,
    buyerInn: null,
    consigneeInn: null,
    createdByUserId: null,
    createdByUserEmail: null,
    createdByUserPhone: null,
    docNumber: null,
    docDate: null,
    totalSum: null,
    vatSum: null,
    expectedDate: file.expectedDate,
    origin: 'manual_pdf',
    llmProviderId: null,
    llmConfidence: null,
    parsedAt: file.createdAt,
    queuedAt: file.createdAt,
    processedAt: null,
    parseErrorCode: null,
    parseErrorDetails: null,
    originalFilename: file.filename,
    contentHash: null,
    jobAttempts: 0,
    version: 0,
    createdAt: file.createdAt,
    updatedAt: file.createdAt,
    validation: null,
    fromSupplierPortal: true,
    groupId: null,
    groupRevision: null,
    portalGroupId: file.portalGroupId,
  } as Row;
}
