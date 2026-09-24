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

/** Сводка инвентаризации: что лежит в ящике, без единого импорта. */
export const EdoInventoryReportSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  eventsSeen: z.number().int(),
  entitiesSeen: z.number().int(),
  truncated: z.boolean(),
  byType: z.array(
    z.object({
      typeNamedId: z.string(),
      function: z.string().nullable(),
      version: z.string().nullable(),
      formalized: z.boolean(),
      count: z.number().int(),
    }),
  ),
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
