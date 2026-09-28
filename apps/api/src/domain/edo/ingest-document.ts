/**
 * Приём одного документа из Диадока: от содержимого до карточки.
 *
 * Устройство повторяет почтовую сагу (`domain/mail/resolve-message.ts`), но без
 * пакета: у ЭДО «один документ — одна карточка», группировать нечего, а
 * `source_documents.bundle_id` допускает пустое значение — так же работает
 * ручной маршрут загрузки XML.
 *
 * Очередь распознавания здесь не используется вовсе: разбирать нечего, реквизиты
 * и позиции уже разложены по полям. В этом и весь смысл затеи — данные ложатся
 * в таблицы без ошибок чтения картинки.
 *
 * Порядок шагов выбран так, чтобы ни один сбой не оставил документ без файла:
 *   1) содержимое скачивается в память;
 *   2) файл кладётся в хранилище и отмечается в журнале — с этого момента он не
 *      потеряется, даже если всё дальнейшее упадёт;
 *   3) карточка создаётся одной транзакцией вместе с отметкой в журнале.
 */
import { and, eq, sql as drSql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { validateUpdTotals } from './upd-validation.js';
import type { Db } from '../../db/client.js';
import {
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
} from '../../db/schema.js';
import type { edoAccounts } from '../../db/schema.js';
import { fileHashOf } from '../sourceDocuments/bundle-key.js';
import { buildS3Key } from '../storage/s3.path.js';
import { putObject } from '../storage/s3.signer.js';
import type { ClassifiedEntity } from './diadoc.entities.js';
import type { DiadocClient } from './diadoc.client.js';
import { DiadocGone, DiadocPayloadTooLarge } from './diadoc.http.js';
import {
  markReceiptRoute,
  markReceiptSkipped,
  markReceiptStored,
  type EdoReceiptRow,
} from './journal.js';
import { findOrCreateCounterparty } from './counterparty.js';
import { detectEdoFile } from './edo-file-kind.js';
import { assessUpdParse, parseUpdXml } from './upd.parser.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { loadEnv } from '../../lib/env.js';

export type IngestDeps = {
  db: Db;
  client: DiadocClient;
  log: FastifyBaseLogger;
  /** Подменяется в тестах, чтобы не ходить в хранилище. */
  put?: typeof putObject;
  /** Предел для машиночитаемого XML: титул УПД — десятки-сотни килобайт. */
  xmlMaxBytes: number;
  /** Предел для остального — PDF и сканы законно тяжелее XML. */
  fileMaxBytes: number;
};

/**
 * Хранилище не приняло файл.
 *
 * Это сбой инфраструктуры, а не документа: проход останавливается, попытка
 * документа возвращается. Иначе час недоступности хранилища сжёг бы бюджет
 * попыток всей очереди. Поэтому ключ хранилища собирается только из
 * идентификатора квитанции и расширения — без номера документа и других данных
 * отправителя: ошибка записи не может зависеть от самого документа, а значит,
 * и не может вечно останавливать ленту на одном из них.
 */
export class EdoStorageUnavailable extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`хранилище не приняло файл: ${detail.slice(0, 200)}`, { cause });
    this.name = 'EdoStorageUnavailable';
  }
}

/**
 * Импорт выключен (`EDO_IMPORT_ENABLED=0`).
 *
 * Проверка стоит на самой границе записи — перед созданием контрагента и
 * карточки, — а не только в начале прохода: любой будущий путь к этой функции
 * (повторный разбор, ручной запуск) упрётся в неё же. Для прохода это остановка,
 * а не сбой документа: попытка не расходуется.
 */
export class EdoImportDisabled extends Error {
  constructor() {
    super('импорт документов из ЭДО выключен (EDO_IMPORT_ENABLED=0)');
    this.name = 'EdoImportDisabled';
  }
}

export type IngestParams = {
  account: typeof edoAccounts.$inferSelect;
  receipt: EdoReceiptRow;
  entity: ClassifiedEntity;
  messageId: string;
};

export type IngestOutcome =
  | { outcome: 'imported'; documentId: string }
  | { outcome: 'duplicate'; documentId: string }
  | { outcome: 'unparsed'; reasons: string[] }
  | { outcome: 'awaiting' }
  | { outcome: 'skipped'; reason: string };

/**
 * Забирает содержимое и сохраняет его.
 *
 * Отдельным шагом, потому что это единственное место, где документ может
 * исчезнуть у источника (404/410) или оказаться неподъёмным. Оба случая
 * терминальны для вложения, но не для прохода: остальные документы ленты должны
 * забираться дальше.
 */
async function fetchAndStore(
  deps: IngestDeps,
  params: IngestParams,
): Promise<{ buffer: Buffer; s3Key: string } | { skipped: string; status: 'vanished' | 'too_large' }> {
  const { account, receipt, entity } = params;
  const put = deps.put ?? putObject;

  // Предел — по маршруту. Прежде всем вложениям доставался предел XML (5 МБ),
  // и PDF крупнее навсегда становился `too_large`, хотя для файлов объявлен
  // свой предел.
  const maxBytes = entity.route === 'utd_xml' ? deps.xmlMaxBytes : deps.fileMaxBytes;

  let buffer: Buffer;
  try {
    buffer = await deps.client.getEntityContent(
      account.boxId as string,
      params.messageId,
      entity.entityId,
      maxBytes,
    );
  } catch (err) {
    if (err instanceof DiadocGone) {
      return { skipped: 'документа больше нет в Диадоке', status: 'vanished' };
    }
    if (err instanceof DiadocPayloadTooLarge) {
      return { skipped: `размер превышает ${maxBytes} байт`, status: 'too_large' };
    }
    throw err;
  }

  const kind = detectEdoFile(buffer, entity.fileName);

  // Ключ детерминирован: повтор перезапишет тот же объект, а не оставит мусор.
  // Объекта у документа из ЭДО ещё нет — папка будет общей, и это принято
  // сознательно: перекладывать ключ после назначения объекта опаснее (ключ в
  // базе и объект в хранилище разъезжаются). В имени — только расширение по
  // содержимому: исходное имя хранится в квитанции, а в ключ не попадает ничего,
  // что задаёт отправитель (см. EdoStorageUnavailable).
  const s3Key = buildS3Key({
    site: null,
    counterparty: null,
    fallbackCounterparty: 'edo',
    entityType: 'source-documents',
    entityId: receipt.id,
    filename: `original.${kind.ext}`,
  });

  const sha256 = fileHashOf(buffer);
  try {
    await put(s3Key, buffer, kind.mimeType, { sha256 });
  } catch (err) {
    throw new EdoStorageUnavailable(err);
  }
  await markReceiptStored(deps.db, receipt.id, {
    rawS3Key: s3Key,
    contentSha256: sha256,
    documentNumber: entity.documentNumber,
    originalFilename: entity.fileName,
    mimeType: kind.mimeType,
    sizeBytes: buffer.length,
  });

  return { buffer, s3Key };
}

export async function ingestEdoEntity(
  deps: IngestDeps,
  params: IngestParams,
): Promise<IngestOutcome> {
  const { account, receipt, entity } = params;

  // Выключенный импорт не должен даже скачивать: сохранённый файл закрыл бы
  // вложение для курсора, а карточка так и не появилась бы. Попытка при этом не
  // расходуется — проход останавливается целиком.
  if (!loadEnv().EDO_IMPORT_ENABLED) throw new EdoImportDisabled();

  const stored = await fetchAndStore(deps, params);
  if ('skipped' in stored) {
    await markReceiptSkipped(deps.db, receipt.id, stored.skipped, stored.status);
    return { outcome: 'skipped', reason: stored.skipped };
  }

  // Неформализованное вложение сохранено, но разбирается отдельным маршрутом:
  // файл не теряется, а ждёт включения распознавания. Для курсора вложение уже
  // закрыто — иначе первый же скан застопорил бы весь ящик.
  if (entity.route !== 'utd_xml') {
    await markReceiptRoute(deps.db, receipt.id, 'awaiting', {
      error: 'неформализованный документ: ждёт включения разбора распознаванием',
    });
    return { outcome: 'awaiting' };
  }

  let parsed;
  try {
    parsed = parseUpdXml(decodeXmlBuffer(stored.buffer));
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'разбор не удался';
    await markReceiptRoute(deps.db, receipt.id, 'not_applicable', { error: reason });
    return { outcome: 'unparsed', reasons: [reason] };
  }

  // «Не бросил исключение» ещё не значит «прочитал документ»: файл незнакомой
  // версии разбирается молча и даёт документ без номера или строки с пустыми
  // суммами. Такое в карточку пускать нельзя — неверные данные хуже, чем их
  // отсутствие, и человек об ошибке даже не узнает.
  const assessment = assessUpdParse(parsed);
  if (!assessment.ok) {
    await markReceiptRoute(deps.db, receipt.id, 'not_applicable', {
      error: `разбор неполон: ${assessment.reasons.join('; ')}`,
    });
    deps.log.warn(
      { receiptId: receipt.id, reasons: assessment.reasons },
      'edo: документ не принят, разбор неполон',
    );
    return { outcome: 'unparsed', reasons: assessment.reasons };
  }

  // Граница записи: дальше создаются контрагент и карточка. Без флага импорта
  // сюда не должен дойти ни один путь, но проверка стоит именно здесь, чтобы
  // её нельзя было обойти новым вызовом в обход прохода по ленте.
  if (!loadEnv().EDO_IMPORT_ENABLED) throw new EdoImportDisabled();

  const supplierId = await findOrCreateCounterparty(deps.db, parsed.supplier, 'supplier');
  const recipientId = parsed.recipient
    ? await findOrCreateCounterparty(deps.db, parsed.recipient, 'customer')
    : null;

  const validation = validateUpdTotals({
    totalSum: parsed.totalSum,
    vatSum: parsed.vatSum,
    items: parsed.items,
  });

  const result = await deps.db.transaction(async (tx): Promise<{ id: string; created: boolean } | null> => {
    const [created] = await tx
      .insert(sourceDocuments)
      .values({
        kind: 'upd',
        direction: 'inbound',
        origin: 'edo_diadoc',
        status: 'parsed',
        edoAccountId: account.id,
        providerMessageId: params.messageId,
        providerEntityId: entity.entityId,
        messageReceivedAt: receipt.receivedAt,
        supplierId,
        supplierInnRaw: parsed.supplier.inn,
        recipientId,
        // Покупатель документа — как на ручном XML-маршруте: распознанная
        // сторона, а не операционный получатель.
        buyerId: recipientId,
        buyerNameRaw: parsed.recipient?.name ?? null,
        buyerInnRaw: parsed.recipient?.inn ?? null,
        // Объект и дату поставки проставляет мониторинг: в документе ЭДО их нет
        // и угадывать нельзя. До этого карточка остаётся «Черновиком» и на
        // планшет не уезжает — предикат выдачи требует оба поля.
        siteId: account.defaultSiteId ?? null,
        docNumber: parsed.docNumber,
        docDate: parsed.docDate ? new Date(parsed.docDate) : null,
        totalSum: parsed.totalSum?.toString() ?? null,
        vatSum: parsed.vatSum?.toString() ?? null,
        validation,
        contentHash: receipt.contentSha256,
        originalFilename: entity.fileName,
        parsedAt: new Date(),
      })
      .onConflictDoNothing({
        // Набор колонок обязан ТОЧНО совпадать с частичным индексом
        // source_edo_message_unique, иначе PostgreSQL отвечает 42P10 на каждом
        // документе — этот дефект уже ловился на почтовом пути.
        target: [
          sourceDocuments.edoAccountId,
          sourceDocuments.providerMessageId,
          sourceDocuments.providerEntityId,
        ],
        where: drSql`${sourceDocuments.edoAccountId} is not null`,
      })
      .returning({ id: sourceDocuments.id });

    if (!created) {
      // Документ уже есть — повторный проход по той же ленте. Возвращаем его id,
      // иначе журнал остался бы без ссылки и утверждал бы, что импорта не было.
      const [existing] = await tx
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(
          and(
            eq(sourceDocuments.edoAccountId, account.id),
            eq(sourceDocuments.providerMessageId, params.messageId),
            eq(sourceDocuments.providerEntityId, entity.entityId),
          ),
        )
        .limit(1);
      return existing ? { id: existing.id, created: false } : null;
    }

    if (parsed.items.length > 0) {
      await tx.insert(sourceDocumentItems).values(
        parsed.items.map((it) => ({
          sourceDocumentId: created.id,
          nameRaw: it.nameRaw,
          qty: it.qty.toString(),
          unit: it.unit,
          price: it.price?.toString() ?? null,
          sum: it.sum?.toString() ?? null,
          vatRate: it.vatRate?.toString() ?? null,
          vatSum: it.vatSum?.toString() ?? null,
          lineNo: it.lineNo,
        })),
      );
    }

    await tx.insert(sourceDocumentAttachments).values({
      sourceDocumentId: created.id,
      s3Key: stored.s3Key,
      filename: entity.fileName ?? `upd-${parsed.docNumber}.xml`,
      mimeType: 'application/xml',
      sizeBytes: stored.buffer.length,
      role: 'original',
    });

    return { id: created.id, created: true };
  });

  if (!result) {
    // Ни вставить, ни найти: единственный правдоподобный случай — документ
    // удалили между вставкой и выборкой. Оставляем вложение незакрытым по
    // маршруту, чтобы следующий проход попробовал снова.
    await markReceiptRoute(deps.db, receipt.id, 'not_applicable', {
      error: 'документ не создан и не найден — повтор на следующем проходе',
    });
    return { outcome: 'unparsed', reasons: ['документ не создан и не найден'] };
  }

  // Повторный проход по той же ленте не должен выглядеть как новый импорт:
  // иначе счётчики в журнале и в отчётах будут врать.
  await markReceiptRoute(deps.db, receipt.id, result.created ? 'imported' : 'duplicate', {
    sourceDocumentId: result.id,
    parseSource: 'local_xml',
  });

  return result.created
    ? { outcome: 'imported', documentId: result.id }
    : { outcome: 'duplicate', documentId: result.id };
}
