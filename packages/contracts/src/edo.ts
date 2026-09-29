import { z } from 'zod';

/**
 * Площадка Диадока. Хранится именем, а не адресом: базовый URL и scope живут в
 * коде (domain/edo/diadoc.http.ts). Свободная строка в БД сделала бы админку
 * источником адреса исходящего запроса, то есть SSRF-вектором.
 *
 * Ящик, выданный на одной площадке, на другой отвечает 403 — поэтому площадка,
 * scope и boxId меняются только вместе.
 */
export const EdoEnvironmentSchema = z.enum(['production', 'staging']);
export type EdoEnvironment = z.infer<typeof EdoEnvironmentSchema>;

/**
 * Схема подключения.
 *
 * `oidc_refresh` — основная и единственная реализованная: Диадок выдаёт новым
 * интеграциям client_id/client_secret, а первичный refresh_token человек
 * получает разово в Кабинете интегратора под СЕРВИСНОЙ учётной записью.
 *
 * `developer_key` оставлен точкой расширения на случай, если у организации уже
 * есть действующий ключ разработчика старого образца. Новым интеграциям такие
 * ключи больше не выдают, поэтому кода под него нет — значение существует,
 * чтобы схема пережила его появление без миграции enum.
 */
export const EdoAuthModeSchema = z.enum(['oidc_refresh', 'developer_key']);
export type EdoAuthMode = z.infer<typeof EdoAuthModeSchema>;

/**
 * Секреты обрезаются по краям, и это не косметика.
 *
 * Их вставляют из буфера обмена, где к значению легко цепляется пробел или
 * перенос строки. Визуально поле выглядит правильным, а сервис авторизации
 * отвечает `invalid_client` — то есть ошибка неотличима от «ключ не тот», и
 * человек идёт искать проблему не там.
 */
const secret = () => z.string().trim().min(1);

export const EdoOidcCredentialsSchema = z.object({
  authMode: z.literal('oidc_refresh'),
  clientId: secret(),
  clientSecret: secret(),
  /** Первичный refresh_token из Кабинета интегратора. Дальше ротируется сам. */
  refreshToken: secret(),
});

export const EdoDeveloperKeyCredentialsSchema = z.object({
  authMode: z.literal('developer_key'),
  apiClientId: z.string().min(1),
  login: z.string().min(1),
  password: z.string().min(1),
});

export const EdoCredentialsSchema = z.discriminatedUnion('authMode', [
  EdoOidcCredentialsSchema,
  EdoDeveloperKeyCredentialsSchema,
]);
export type EdoCredentials = z.infer<typeof EdoCredentialsSchema>;

/**
 * Чтение того, что уже лежит в БД.
 *
 * Записи, созданные до перехода на OIDC, не содержат `authMode` — без
 * подстановки discriminated union отверг бы их, и учётная запись стала бы
 * нечитаемой. Поле boxId в старом формате лежало внутри credentials; теперь у
 * него отдельная колонка, поэтому при чтении оно просто игнорируется.
 */
export const StoredEdoCredentialsSchema = z.preprocess((v) => {
  if (v && typeof v === 'object' && !('authMode' in v)) {
    return { ...(v as Record<string, unknown>), authMode: 'developer_key' };
  }
  return v;
}, EdoCredentialsSchema);

/**
 * Состояние авторизации: то, что система обновляет сама.
 *
 * Хранится ОТДЕЛЬНО от введённых человеком секретов. Если сложить их вместе,
 * правка названия учётной записи в админке затёрла бы живой refresh_token, а
 * восстановить его можно только руками через браузер.
 */
export const EdoAuthStateSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  /** Unix-время в миллисекундах, когда access_token перестанет действовать. */
  accessTokenExpiresAt: z.number().int().optional(),
});
export type EdoAuthState = z.infer<typeof EdoAuthStateSchema>;

/**
 * Категории отбора по метаданным (без скачивания): что это за документ и
 * берём ли его. Перечень закрыт — у каждой категории своя подпись в интерфейсе.
 */
export const EdoMetaCategorySchema = z.enum([
  'utd_candidate',
  'utd_invoice_only',
  'invoice',
  'revision',
  'correction',
  'waybill',
  'not_delivery',
  'scan',
  'excluded',
]);
export type EdoMetaCategory = z.infer<typeof EdoMetaCategorySchema>;

/** Категории по содержимому УПД: признак предмета позиций (`ПрТовРаб`). */
export const EdoContentCategorySchema = z.enum([
  'materials',
  'services',
  'undetermined',
  'invoice_only',
]);
export type EdoContentCategory = z.infer<typeof EdoContentCategorySchema>;

const CategoryCountSchema = z.object({
  category: z.string(),
  label: z.string(),
  count: z.number().int(),
});

/** Сводка инвентаризации: что лежит в ящике, без единого импорта. */
export const EdoInventoryReportSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  eventsSeen: z.number().int(),
  entitiesSeen: z.number().int(),
  truncated: z.boolean(),
  /**
   * Сколько событий несли время и откуда оно взято.
   *
   * Нужно, чтобы пустой период в отчёте не выглядел как «ящик пуст»: на боевом
   * ящике 24.09.2026 время не нашлось ни у одного из двух тысяч событий, и
   * отличить это от отсутствия документов было нечем.
   *
   * Поля необязательные: отчёты, снятые до появления счётчика, их не содержат,
   * а ответ со списком учётных записей проверяется по этой же схеме.
   */
  timedEvents: z.number().int().optional(),
  timeSource: z.enum(['event', 'message', 'patch']).nullable().optional(),
  byType: z.array(
    z.object({
      typeNamedId: z.string(),
      /** Название типа по справочнику Диадока («УПД», «Акт»…), если он ответил. */
      title: z.string().nullable().optional(),
      function: z.string().nullable(),
      version: z.string().nullable(),
      formalized: z.boolean(),
      /** Откуда известно «машиночитаемый»: справочник Диадока или версия формата. */
      formalizedSource: z.enum(['reference', 'version']).optional(),
      /** Что делаем с документами этого типа (уровень 1 отбора). */
      decision: EdoMetaCategorySchema.optional(),
      decisionLabel: z.string().optional(),
      count: z.number().int(),
    }),
  ),
  /**
   * Итог отбора по метаданным: сколько документов какой категории. Сюда же
   * попадают исключённые (тестовые, аннулированные…), которых нет в byType.
   * Необязательное: у отчётов до выпуска 2 его нет.
   */
  decisions: z.array(CategoryCountSchema).optional(),
  /**
   * Проверка содержимого: сколько УПД-кандидатов оказались материалами, а
   * сколько — работами или услугами. Есть только у осмотра с галочкой
   * «Проверить содержимое».
   */
  contentCheck: z
    .object({
      limit: z.number().int(),
      checked: z.number().int(),
      failed: z.number().int(),
      byContent: z.array(CategoryCountSchema),
      /** Проверка остановлена по времени: доли относятся к проверенной части. */
      interrupted: z.enum(['deadline']).nullable(),
    })
    .nullable()
    .optional(),
});
export type EdoInventoryReport = z.infer<typeof EdoInventoryReportSchema>;

/**
 * Наружу секреты не уходят никогда — только признаки их наличия и возраст
 * токена. Возраст нужен по делу: refresh_token живёт 30 дней, счётчик
 * продлевается при каждом использовании, поэтому учётная запись с выключенным
 * опросом умирает молча.
 */
export const EdoAccountDtoSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  pollEnabled: z.boolean(),
  /**
   * Включён ли импорт (флаг окружения `EDO_IMPORT_ENABLED`, общий для всех
   * учётных записей). Пока он выключен, сервер отклоняет синхронизацию и
   * включение опроса, а интерфейс гасит эти кнопки заранее.
   */
  importEnabled: z.boolean(),
  authMode: EdoAuthModeSchema,
  environment: EdoEnvironmentSchema,
  boxId: z.string().nullable(),
  orgInn: z.string().nullable(),
  defaultSiteId: z.string().uuid().nullable(),
  /**
   * client_id — идентификатор приложения, не секрет. Показывается целиком:
   * без него опечатку в нём невозможно заметить глазами, а отвечает на неё
   * сервис авторизации тем же `invalid_client`, что и на неверный ключ.
   */
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  hasRefreshToken: z.boolean(),
  /** Длины секретов: сравнить с тем, что выдал Кабинет, не раскрывая значений. */
  clientSecretLength: z.number().int().nullable(),
  refreshTokenLength: z.number().int().nullable(),
  /**
   * Первые 8 символов sha256 от секрета.
   *
   * Длина ловит обрезанное значение, но не подменённое: два разных ключа одной
   * длины неразличимы. Отпечаток закрывает этот пробел — его можно посчитать у
   * себя (`printf %s 'ЗНАЧЕНИЕ' | sha256sum | cut -c1-8`) и сравнить глазами,
   * не пересылая сам секрет. Восемь шестнадцатеричных символов от хеша
   * высокоэнтропийного значения обратно не разворачиваются.
   */
  clientSecretFingerprint: z.string().nullable(),
  refreshTokenFingerprint: z.string().nullable(),
  refreshTokenAgeDays: z.number().int().nullable(),
  lastEventAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastError: z.string().nullable(),
  backfillSince: z.string().nullable(),
  /**
   * Последняя разведка ящика. Лежит в карточке, а не в отдельном запросе:
   * отчёт маленький, а без него кнопка «Осмотреть ящик» бесполезна — работа
   * уходит в очередь, и человеку негде увидеть, чем она кончилась.
   */
  lastInventory: EdoInventoryReportSchema.nullable(),
  lastInventoryAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EdoAccountDto = z.infer<typeof EdoAccountDtoSchema>;

export const EdoAccountCreateSchema = z.object({
  provider: z.literal('diadoc').default('diadoc'),
  name: z.string().min(1).max(100),
  environment: EdoEnvironmentSchema.default('production'),
  credentials: EdoCredentialsSchema,
  /** Можно не указывать: подставится после «Проверить доступ». */
  boxId: z.string().min(1).optional(),
  orgInn: z.string().min(10).max(12).optional(),
  defaultSiteId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type EdoAccountCreate = z.infer<typeof EdoAccountCreateSchema>;

/**
 * Правка учётной записи.
 *
 * Пустые `clientSecret` / `refreshToken` означают «оставить прежние», а не
 * «стереть»: форма не показывает секреты, и пустое поле в ней — это «не менял».
 * Смена `clientId`, площадки или первичного refresh_token обнуляет состояние
 * авторизации: прежний access_token относится к другому подключению.
 */
export const EdoAccountPatchSchema = z
  .object({
    name: z.string().min(1).max(100),
    isActive: z.boolean(),
    pollEnabled: z.boolean(),
    environment: EdoEnvironmentSchema,
    boxId: z.string().min(1),
    orgInn: z.string().min(10).max(12).nullable(),
    defaultSiteId: z.string().uuid().nullable(),
    credentials: z.object({
      clientId: secret().optional(),
      clientSecret: secret().optional(),
      refreshToken: secret().optional(),
    }),
  })
  .partial();
export type EdoAccountPatch = z.infer<typeof EdoAccountPatchSchema>;

/** Результат «Проверить доступ»: ящики учётной записи и её права. */
export const EdoCheckResultSchema = z.object({
  employee: z.object({
    isBlocked: z.boolean(),
    documentAccessLevel: z.string().nullable(),
    /** Хватает ли прав для работы интеграции (нужен доступ ко всем документам). */
    hasRequiredAccess: z.boolean(),
  }),
  boxes: z.array(
    z.object({
      boxId: z.string(),
      title: z.string(),
      inn: z.string().nullable(),
      kpp: z.string().nullable(),
    }),
  ),
});
export type EdoCheckResult = z.infer<typeof EdoCheckResultSchema>;

/** Постановка фоновой работы: обход ленты синхронным ответом держать нельзя. */
export const EdoJobQueuedSchema = z.object({
  queued: z.literal(true),
  jobId: z.string(),
});
export type EdoJobQueued = z.infer<typeof EdoJobQueuedSchema>;

/**
 * Журнал приёма: что произошло с документами ящика.
 *
 * Нужен не «для полноты»: без него единственный ответ на «почему документ не
 * приехал» — лезть в базу. Транспорт и маршрут показываются раздельно, потому
 * что это разные вопросы: забрали ли файл и что с ним сделали дальше.
 */
export const EdoJournalEntrySchema = z.object({
  id: z.string().uuid(),
  messageId: z.string(),
  entityId: z.string(),
  documentNumber: z.string().nullable(),
  documentType: z.string().nullable(),
  documentVersion: z.string().nullable(),
  transportStatus: z.string(),
  routeStatus: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  sourceDocumentId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type EdoJournalEntry = z.infer<typeof EdoJournalEntrySchema>;

export const EdoJournalSummarySchema = z.object({
  byTransport: z.array(z.object({ status: z.string(), count: z.number().int() })),
  byRoute: z.array(z.object({ status: z.string(), count: z.number().int() })),
  eventsPending: z.number().int(),
  entries: z.array(EdoJournalEntrySchema),
});
export type EdoJournalSummary = z.infer<typeof EdoJournalSummarySchema>;

/**
 * Совместимость: прежнее имя схемы создания. Старый контракт требовал
 * apiClientId/login/password, поэтому импортировать его под новым смыслом
 * нельзя — оставлен алиас на новую схему создания.
 */
export const EdoAccountUpsertSchema = EdoAccountCreateSchema;
export type EdoAccountUpsert = EdoAccountCreate;

/**
 * Пробный разбор: что вычитается из настоящих документов ящика.
 *
 * Нужен потому, что до сих пор выбор был из двух крайностей — разведка, которая
 * только считает типы, и импорт, который сразу создаёт карточки. Разбор XML на
 * бою не выполнялся ни разу, и пускать его результат прямо в раздел «Документы»
 * вслепую незачем: сначала видно, что именно парсер прочитал.
 *
 * Отчёт нигде не сохраняется — он одноразовый и возвращается прямо в ответе.
 */
export const EdoDryRunItemSchema = z.object({
  lineNo: z.number().int(),
  name: z.string(),
  qty: z.number(),
  unit: z.string(),
  price: z.number().nullable(),
  /** С НДС — как в карточке. */
  sum: z.number().nullable(),
  sumExVat: z.number().nullable(),
  vatRate: z.number().nullable(),
  /** ПрТовРаб: 1 — имущество, 2 — работа, 3 — услуга, 4 — права, 5 — иное. */
  kind: z.number().int().nullable(),
  productCode: z.string().nullable(),
});

export const EdoDryRunPartySchema = z.object({
  inn: z.string(),
  kpp: z.string().nullable(),
  name: z.string(),
});

const EdoDryRunShipPartySchema = z.object({
  inn: z.string().nullable(),
  kpp: z.string().nullable(),
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const EdoDryRunDocRefSchema = z.object({
  name: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
});

/** «Путь → значение»: сырые поля ответа Диадока, без содержимого файла. */
const EdoDryRunFieldSchema = z.object({ path: z.string(), value: z.string() });

/** Что о документе знает сам Диадок, до чтения содержимого. */
const EdoDryRunMetaSchema = z.object({
  typeNamedId: z.string().nullable(),
  function: z.string().nullable(),
  version: z.string().nullable(),
  documentNumber: z.string().nullable(),
  documentDate: z.string().nullable(),
  /** Номер и дата из коллекции Metadata или из устаревших прямых полей. */
  numberSource: z.enum(['metadata', 'legacy']).nullable(),
  totalSum: z.string().nullable(),
  fileName: z.string().nullable(),
  counteragentBoxId: z.string().nullable(),
  /** Когда документ доставлен (иначе — время сообщения). */
  receivedAt: z.string().nullable(),
  receivedAtSource: z.enum(['delivery', 'message']).nullable(),
  isTest: z.boolean(),
  revocationStatus: z.string().nullable(),
  senderSignatureStatus: z.string().nullable(),
});

export const EdoDryRunDocumentSchema = z.object({
  messageId: z.string(),
  entityId: z.string(),
  meta: EdoDryRunMetaSchema,
  /** Итог отбора по содержимому. null — содержимое прочитать не удалось. */
  content: z
    .object({
      category: EdoContentCategorySchema,
      label: z.string(),
      reason: z.string(),
      kinds: z.object({
        goods: z.number().int(),
        work: z.number().int(),
        service: z.number().int(),
        rights: z.number().int(),
        other: z.number().int(),
        unknown: z.number().int(),
      }),
    })
    .nullable(),
  /** Что вычитал наш разбор. null — разбор не состоялся, причина в reasons. */
  parsed: z
    .object({
      docNumber: z.string(),
      docDate: z.string(),
      correction: z.object({ number: z.string().nullable(), date: z.string().nullable() }).nullable(),
      supplier: EdoDryRunPartySchema,
      suppliers: z.array(EdoDryRunPartySchema),
      recipient: EdoDryRunPartySchema.nullable(),
      buyers: z.array(EdoDryRunPartySchema),
      consignorSameAsSeller: z.boolean(),
      consignor: EdoDryRunShipPartySchema.nullable(),
      consignee: EdoDryRunShipPartySchema.nullable(),
      transfer: z
        .object({
          date: z.string().nullable(),
          operation: z.string().nullable(),
          basis: z.array(EdoDryRunDocRefSchema),
        })
        .nullable(),
      shippingDocs: z.array(EdoDryRunDocRefSchema),
      itemsCount: z.number().int(),
      /** С НДС — база портала. */
      totalSum: z.number().nullable(),
      totalExVat: z.number().nullable(),
      vatSum: z.number().nullable(),
      formatVersion: z.string().nullable(),
      function: z.string().nullable(),
      currencyCode: z.string().nullable(),
      /** Первые несколько позиций — чтобы увидеть, что читаются именно они. */
      sampleItems: z.array(EdoDryRunItemSchema),
    })
    .nullable(),
  /** Попал бы документ в карточку при настоящем импорте. */
  accepted: z.boolean(),
  reasons: z.array(z.string()),
  /**
   * Расхождения между метаданными Диадока и разбором XML. Самый быстрый признак
   * того, что парсер читает не те поля: провайдер и содержимое не сойдутся.
   */
  mismatches: z.array(z.string()),
  sizeBytes: z.number().int().nullable(),
  /** «Что сообщает Диадок»: сырые поля сущности и документа. */
  diadocFields: z.array(EdoDryRunFieldSchema),
  /** «Структура XML»: пути атрибутов и элементов, объединённые по строкам. */
  xmlOutline: z.array(z.string()),
  /** «Чего не хватает до карточки»: поле и подсказка, откуда его взять. */
  missingForCard: z.array(z.object({ field: z.string(), hint: z.string() })),
  /** Подсказка из портала: возил ли поставщик материалы раньше. */
  supplierHistory: z
    .object({ deliveries: z.number().int(), lastAt: z.string().nullable() })
    .nullable(),
});

/** Скан или файл без типа: только метаданные, содержимое не скачивается. */
export const EdoDryRunScanSchema = z.object({
  messageId: z.string(),
  entityId: z.string(),
  meta: EdoDryRunMetaSchema,
  reason: z.string(),
  diadocFields: z.array(EdoDryRunFieldSchema),
});

export const EdoDryRunReportSchema = z.object({
  eventsSeen: z.number().int(),
  /** Обход остановлен на пределе: «не нашли» относится к просмотренному отрезку. */
  truncated: z.boolean(),
  /** Сколько УПД-кандидатов (СЧФДОП/ДОП) встретилось за просмотренный отрезок. */
  candidates: z.number().int(),
  /** Сколько из них скачано и разобрано: предел намеренно небольшой. */
  examined: z.number().int(),
  /** Прервано по общему пределу времени: показано то, что успели. */
  interrupted: z.enum(['deadline']).nullable(),
  /** Итог отбора: по метаданным — все документы, по содержимому — разобранные. */
  selection: z.object({
    byMeta: z.array(CategoryCountSchema),
    byContent: z.array(CategoryCountSchema),
  }),
  documents: z.array(EdoDryRunDocumentSchema),
  scans: z.array(EdoDryRunScanSchema),
});
export type EdoDryRunReport = z.infer<typeof EdoDryRunReportSchema>;
export type EdoDryRunDocument = z.infer<typeof EdoDryRunDocumentSchema>;
