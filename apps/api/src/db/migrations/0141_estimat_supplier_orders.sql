-- Заказы поставщикам из EstiMat (сметный портал СУ-10) и их привязка к приёмкам.
--
-- estimat_supplier_orders — зеркало заказа, ключ — id из EstiMat. Полный обход
-- по курсору раз в полчаса записывает заказы upsert'ом; заказ, которого не
-- оказалось в полном обходе, помечается deleted_at и не стирается. Обход
-- отмечает каждый увиденный заказ id ПОПЫТКИ (last_seen_pass_id): после рестарта
-- с первой страницы заказ из брошенной попытки не считается увиденным.
--
-- estimat_supplier_order_events — журнал заказа: виза (поставлена, снята,
-- поставлена повторно), стадия, удаление, привязки к приёмкам. run_id и
-- delivery_id без FK: журнал переживает и чистку обходов, и удаление приёмки.
--
-- estimat_sync_runs — журнал обходов. Частичный уникальный индекс по
-- outcome = 'running' не даёт двум обходам идти одновременно (например, старому
-- и новому mail-worker во время деплоя).
--
-- delivery_supplier_orders — связь приёмки с заказами (несколько к нескольким).
-- Таблица deliveries не меняется: мобильный клиент и upsert приёмки связь не видят.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS estimat_supplier_orders (
  id uuid PRIMARY KEY,
  order_no integer,
  sub_no integer,
  estimat_project_id uuid,
  project_code text,
  project_name text,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  contractors jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_name text,
  supplier_inn text,
  amount numeric(18, 2),
  sourcing_status text NOT NULL,
  procurement_method text,
  acquisition_type text,
  contract_number text,
  contract_date text,
  awarded_at timestamptz,
  supply_approved_at timestamptz,
  estimat_created_at timestamptz,
  estimat_updated_at timestamptz,
  raw jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_pass_id uuid NOT NULL,
  deleted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_site_idx ON estimat_supplier_orders (site_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_status_idx ON estimat_supplier_orders (sourcing_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_supplier_inn_idx ON estimat_supplier_orders (supplier_inn);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_number_idx ON estimat_supplier_orders (order_no, sub_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_contractors_idx
  ON estimat_supplier_orders USING gin (contractors jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_orders_live_idx
  ON estimat_supplier_orders (estimat_project_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS estimat_supplier_order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES estimat_supplier_orders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  from_value text,
  to_value text,
  details jsonb,
  run_id uuid,
  delivery_id uuid,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT estimat_supplier_order_events_kind_check CHECK (kind IN (
    'first_seen', 'approved', 'approval_revoked', 'reapproved', 'status_changed',
    'deleted', 'restored', 'delivery_linked', 'delivery_unlinked'
  ))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_supplier_order_events_order_idx
  ON estimat_supplier_order_events (order_id, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS estimat_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL,
  triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  current_pass_id uuid NOT NULL DEFAULT gen_random_uuid(),
  pages integer NOT NULL DEFAULT 0,
  orders_seen integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  approval_changes integer NOT NULL DEFAULT 0,
  status_changes integer NOT NULL DEFAULT 0,
  marked_deleted integer NOT NULL DEFAULT 0,
  restored integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  invalid_rows_no_id integer NOT NULL DEFAULT 0,
  restarts integer NOT NULL DEFAULT 0,
  unmatched_sites integer NOT NULL DEFAULT 0,
  token_project_id uuid,
  scope_confirmed boolean NOT NULL DEFAULT false,
  deletion_skipped_reason text,
  error_code text,
  error_message text,
  request_id text,
  token_fingerprint text,
  CONSTRAINT estimat_sync_runs_trigger_check CHECK (trigger IN ('auto', 'manual', 'script')),
  CONSTRAINT estimat_sync_runs_outcome_check
    CHECK (outcome IN ('running', 'completed', 'error', 'stopped', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS estimat_sync_runs_one_running_idx
  ON estimat_sync_runs (outcome) WHERE outcome = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS estimat_sync_runs_started_idx ON estimat_sync_runs (started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS delivery_supplier_orders (
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES estimat_supplier_orders(id) ON DELETE RESTRICT,
  linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  site_mismatch boolean NOT NULL DEFAULT false,
  CONSTRAINT delivery_supplier_orders_pkey PRIMARY KEY (delivery_id, order_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_supplier_orders_order_idx ON delivery_supplier_orders (order_id);
