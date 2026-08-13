import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Волна 0A: инструментовка запросов (число SQL/длительность/размер ответа на
  // HTTP-вызов) для baseline перед оптимизациями. Выключено по умолчанию —
  // нулевой оверхед; включать временно на staging/проде для замера пика.
  //
  // Тот же приём с enum('0','1'), что у PERMISSIONS_ENFORCE: z.coerce.boolean()
  // превращает ЛЮБУЮ непустую строку в true, включая '0' и 'false', — то есть
  // REQUEST_METRICS_ENABLED=0 не выключал бы метрики, а включал. Плагин пишет
  // строку в лог на каждый HTTP-ответ, поэтому «рубильник, который нельзя
  // выключить» здесь означает ещё и распухание логов.
  REQUEST_METRICS_ENABLED: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['0', '1']).default('0'))
    .transform((v) => v === '1'),

  // Применение матрицы прав ролей (раздел «Администрирование» → «Роли»).
  //
  // Выключено по умолчанию: включать только после того, как интерфейс научился
  // прятать запрещённые действия, и после мобильного smoke на планшете КПП.
  // Иначе получится худшее сочетание — кнопка на экране есть, а нажатие даёт
  // ошибку.
  //
  // Выключение — ПОЛНЫЙ откат, а не половинчатый: сервер перестаёт запрещать,
  // а GET /me/permissions начинает отдавать дефолты, игнорируя сохранённые
  // overrides, — интерфейс тоже возвращается к исходному виду. Сами overrides
  // остаются в БД и оживают при обратном включении.
  //
  // НЕ z.coerce.boolean(): Boolean('0') === true, то есть PERMISSIONS_ENFORCE=0
  // включил бы enforcement вместо выключения — рубильник, который нельзя
  // выключить, хуже отсутствующего.
  //
  // preprocess: пустая строка (`PERMISSIONS_ENFORCE=` — ровно то, что выходит
  // при копировании env-примера с незаполненным значением) приходит в схему как
  // '', а не undefined, и .default() до неё не доходит. Без этого валидация
  // падала бы и роняла api и worker на старте.
  PERMISSIONS_ENFORCE: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['0', '1']).default('0'))
    .transform((v) => v === '1'),

  // Сборка логических УПД: страницы одной УПД склеиваются в ОДИН документ
  // вместо «файл = документ».
  //
  // Выключено по умолчанию. Включать только после боевой проверки: путь
  // затрагивает распознавание, а его сбой виден не сразу — пакет разъезжается
  // на обрубки, и заметить это можно лишь в «Документах».
  //
  // Выключение — полный откат: router возвращается к пофайловому разбору, уже
  // опубликованные группы остаются как есть (assembly_version у пакета не
  // пересматривается).
  //
  // Тот же приём с enum('0','1'), что у PERMISSIONS_ENFORCE: z.coerce.boolean()
  // превратил бы '0' в true, и рубильник нельзя было бы выключить.
  UPD_ASSEMBLY_V1: z
    .preprocess((v) => (v === '' ? undefined : v), z.enum(['0', '1']).default('0'))
    .transform((v) => v === '1'),

  // Потолок страниц на пакет для сборки. Двадцать разрешённых к загрузке PDF
  // дают сотни страниц: это десятки vision-вызовов в воркере с CONCURRENCY=1,
  // то есть очередь встанет. При превышении пакет уходит прежним путём
  // «файл = документ» — без сборки, но и без зависшего воркера.
  UPD_ASSEMBLY_MAX_TOTAL_PAGES: z.coerce.number().int().positive().default(40),

  // DB / Redis
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(30),
  REDIS_URL: z.string().optional(),

  // Внешняя БД ФОТ (read-only) — список МОЛ. Отдельный пул, не основной.
  // Если не задан — эндпоинт /api/v1/mol отдаёт пустой список с флагом stale.
  FOT_DATABASE_URL: z.string().url().optional(),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Внешний адрес портала для ссылок, которые уходят людям наружу (share на
  // приёмку, сброс пароля). Намеренно НЕ обязателен даже в production: этот
  // env-файл общий для api, worker и mail-worker, и падение валидации уронило
  // бы все три процесса разом. Требование проверяется точечно там, где строится
  // ссылка (см. lib/public-url.ts).
  PUBLIC_BASE_URL: z.string().url().optional(),

  // JWT (Ed25519)
  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  JWT_ISSUER: z.string().default('matcheck-api'),
  JWT_AUDIENCE: z.string().default('matcheck-web'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  REFRESH_TOKEN_ABSOLUTE_MAX_DAYS: z.coerce.number().int().positive().default(90),

  // Окно, внутри которого повторное предъявление уже отозванного refresh-токена
  // считается потерянным ответом, а не кражей: сервер повторно выдаёт ту же
  // замену вместо того, чтобы убить сессию (см. domain/auth/refresh.ts).
  //
  // 60с покрывает наблюдавшийся на проде разброс между успешной ротацией и
  // повтором (от долей секунды у параллельных запросов до ~60с у клиента,
  // оборвавшего fetch по 10-секундному таймауту). 0 — аварийное отключение
  // replay без релиза; потолок 300 — чтобы окно нельзя было раздуть до суток.
  //
  // preprocess: пустая строка (REFRESH_REUSE_GRACE_SECONDS= при копировании
  // env-примера) иначе прошла бы через z.coerce.number() как 0 и молча
  // выключила бы защиту от ложных разлогинов — ровно наоборот к умолчанию.
  REFRESH_REUSE_GRACE_SECONDS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(300).default(60),
  ),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Базовый шаг нарастающей паузы после неверного пароля: n-я подряд неудача
  // ждёт BASE * 2^(n-1), но не дольше 30 секунд. Единственное, что тормозит
  // перебор на /auth/login — блокировки аккаунта там больше нет, см. auth.ts.
  // В тестах ставим 1, иначе набор из полутора десятков неудач спит минутами.
  AUTH_BACKOFF_BASE_MS: z.coerce.number().int().nonnegative().default(1000),

  // CSRF
  CSRF_SECRET: z.string().min(32).optional(),

  // Field encryption (AES-256-GCM, key map JSON)
  APP_FIELD_ENCRYPTION_KEYS: z
    .string()
    .default('{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'),
  APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: z.string().default('v1'),

  // Sentry (мониторинг ошибок). instrument.ts читает process.env.SENTRY_* напрямую
  // (до цепочки модулей); здесь — только для валидации/документации. DSN публичный.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_RELEASE: z.string().optional(),

  // Почтовый канал приёма документов.
  //
  // MAIL_POLL_ENABLED — главный выключатель: без него отдельный процесс
  // mail-worker не опрашивает ничего, даже если у ящика включён poll_enabled.
  // Две независимые защиты нужны, чтобы включение опроса было осознанным
  // действием, а не следствием деплоя.
  MAIL_POLL_ENABLED: z.coerce.boolean().default(false),
  MAIL_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  MAIL_POLL_MAX_MESSAGES: z.coerce.number().int().positive().default(50),
  MAIL_POLL_LEASE_SEC: z.coerce.number().int().positive().default(900),
  // Письмо целиком. Держится кратно ниже памяти контейнера: письмо существует
  // сырым буфером, MIME-структурой и декодированными вложениями ОДНОВРЕМЕННО,
  // то есть пик втрое выше самого размера. На VPS память общая с соседними
  // проектами, и вытеснение чужого процесса дороже, чем пропуск письма.
  //
  // Письмо крупнее предела не теряется: оно не скачивается и попадает в список
  // незабранных, где оператор может поднять лимит и затребовать повтор.
  MAIL_LETTER_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  // Вложение по определению меньше письма — держим предел согласованным.
  MAIL_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  // Защита от zip-бомбы в xlsx: три независимых предела.
  MAIL_XLSX_MAX_ENTRIES: z.coerce.number().int().positive().default(512),
  MAIL_XLSX_MAX_INFLATED_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  MAIL_XLSX_MAX_RATIO: z.coerce.number().int().positive().default(200),
  // Срок хранения разобранной почты, дни. По умолчанию 0 — НЕ УДАЛЯТЬ.
  //
  // Оригинал письма это доказательство «подрядчик прислал вот это и вот тогда»,
  // и оно может понадобиться в споре, поэтому автоудаление включается только
  // осознанно. Объём невелик: письма лежат в объектном хранилище, диск сервера
  // не затрагивается совсем.
  //
  // Если включить: удаляются ТОЛЬКО сырое письмо и временные копии вложений, и
  // только у писем, с которыми уже разобрались. Документы, их постоянные файлы,
  // приёмки и фото не затрагиваются; письма в разборе не удаляются никогда.
  MAIL_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

  // Публичная форма /uploads — потолки приёма.
  //
  // Значения по умолчанию согласованы с мощностью воркера: при CONCURRENCY=1
  // он разбирает 200-300 файлов в час, а по манифестам боевых отправок на один
  // запрос приходится ~1,1 файла. То есть 200 запросов/час — это ровно то, что
  // конвейер успевает переварить; поднимать вслепую значит копить очередь.
  // Ручка нужна, чтобы в день массовой загрузки подкрутить лимит по фактам из
  // логов (глубина очереди upd-parse), а не выкатывать образ.
  PUBLIC_UPLOAD_GLOBAL_MAX: z.coerce.number().int().positive().default(200),
  // Per-IP за 10 минут: один визит — до 10 поставок отдельными запросами плюс
  // запас на повторы. За одним внешним IP может сидеть весь офис подрядчика.
  PUBLIC_UPLOAD_IP_MAX: z.coerce.number().int().positive().default(20),

  // S3 (cloud.ru)
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ru-central-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
