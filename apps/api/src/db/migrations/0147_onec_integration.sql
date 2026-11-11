-- Выгрузка приёмок в 1С (pull + ack), выпуск 1.
--
-- service_accounts — машинные учётки по docs/fin_auth.md §2: client_id + секрет
-- (в базе только sha256 256-битного секрета), scopes, необязательный список сетей.
-- secret_generation попадает в machine-токен (claim gen): ротация секрета
-- отзывает все выданные токены сравнением поколения, без сравнения времени
-- выпуска (граница секунды у iat не играет).
--
-- delivery_onec_exports — что лежит в 1С по каждой приёмке. delivery_id БЕЗ FK:
-- строка обязана пережить жёсткое удаление приёмки, иначе 1С не узнает об
-- удалении. content_hash NULL — успешного подтверждения ещё не было (строку
-- могла создать ошибка первой загрузки); 'deleted' — 1С применила удаление.
-- queue_reason/queue_since — одна сохранённая причина повторной выдачи и её
-- устойчивое время для порядка очереди; pending_hash — последний вычисленный
-- текущий хеш для 'changed'.
--
-- onec_detection_state — одна строка: когда начался последний проход поиска
-- изменений (окно поиска отсчитывается от него, чтобы простой 1С не терял
-- изменения на границе окна).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE service_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar(64) NOT NULL,
  name text NOT NULL,
  secret_hash varchar(64) NOT NULL,
  secret_generation integer NOT NULL DEFAULT 1,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  allowed_cidrs text[],
  is_active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  last_token_at timestamptz,
  last_token_ip varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_accounts_client_id_uq UNIQUE (client_id),
  CONSTRAINT service_accounts_client_id_format CHECK (client_id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  CONSTRAINT service_accounts_secret_hash_format CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT service_accounts_generation_positive CHECK (secret_generation >= 1)
);
--> statement-breakpoint
CREATE TABLE delivery_onec_exports (
  delivery_id uuid PRIMARY KEY,
  display_id bigint,
  content_hash varchar(64),
  hash_version integer,
  exported_at timestamptz,
  first_exported_at timestamptz,
  last_ack_at timestamptz,
  ack_count integer NOT NULL DEFAULT 0,
  queue_reason text,
  queue_since timestamptz,
  pending_hash varchar(64),
  last_error text,
  last_error_at timestamptz,
  service_account_id uuid REFERENCES service_accounts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_onec_exports_hash_format
    CHECK (content_hash IS NULL OR content_hash = 'deleted' OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delivery_onec_exports_pending_format
    CHECK (pending_hash IS NULL OR pending_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delivery_onec_exports_reason_check
    CHECK (queue_reason IS NULL OR queue_reason IN ('changed', 'deleted', 'restored')),
  -- Пока 1С ничего не подтвердила, причины повторной выдачи быть не может:
  -- такая приёмка в очереди как new, и это вычисляется, а не хранится.
  CONSTRAINT delivery_onec_exports_reason_needs_hash
    CHECK (content_hash IS NOT NULL OR queue_reason IS NULL),
  CONSTRAINT delivery_onec_exports_reason_since
    CHECK ((queue_reason IS NULL) = (queue_since IS NULL)),
  CONSTRAINT delivery_onec_exports_hash_exported_at
    CHECK ((content_hash IS NULL) = (exported_at IS NULL)),
  CONSTRAINT delivery_onec_exports_hash_version
    CHECK (content_hash IS NULL OR content_hash = 'deleted' OR hash_version IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX delivery_onec_exports_exported_at_idx ON delivery_onec_exports (exported_at);
--> statement-breakpoint
CREATE INDEX delivery_onec_exports_queue_idx
  ON delivery_onec_exports (queue_since, delivery_id)
  WHERE queue_reason IS NOT NULL;
--> statement-breakpoint
CREATE TABLE onec_detection_state (
  id integer PRIMARY KEY DEFAULT 1,
  last_pass_started_at timestamptz,
  last_pass_finished_at timestamptz,
  last_pass_rows integer,
  last_pass_ms integer,
  CONSTRAINT onec_detection_state_singleton CHECK (id = 1)
);
