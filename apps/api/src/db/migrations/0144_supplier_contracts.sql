-- Договоры с контрагентами из 1С (выгрузка «группа Снабжение») и выбор договора в приёмке.
--
-- supplier_contracts — справочник договоров. Ключ сопоставления — GUID договора
-- в 1С (onec_id). Пишет его только CLI scripts/import-contracts.ts: dry-run →
-- --apply --confirm. Строки не удаляются: договор, которого нет в очередной
-- выгрузке, получает missing_since. Объект договора определяется правилами по
-- тексту (site_status/site_ids/site_rule) — это подсказка для подбора, не запрет.
--
-- supplier_contract_imports — по строке на применённый импорт. «Действующий» —
-- последний без reverted_at: только его можно откатить (--revert), и его
-- applied_at окно подбора показывает как «загружено».
--
-- delivery_contracts — договор приёмки, ОДИН на приёмку (PK по delivery_id).
-- Таблица deliveries не меняется: мобильный клиент и upsert приёмки связь не видят.
--
-- delivery_contract_events — журнал привязок. Замена затирает строку связи,
-- поэтому «кто и когда поменял» живёт только здесь. delivery_id без FK: журнал
-- переживает удаление приёмки.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  onec_id uuid NOT NULL,
  counterparty_onec_id uuid,
  counterparty_name text NOT NULL,
  counterparty_inn text NOT NULL,
  name text NOT NULL,
  number text,
  contract_date date,
  kind text NOT NULL,
  object_text text,
  site_status text NOT NULL DEFAULT 'none',
  site_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  site_rule text,
  missing_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_contracts_onec_id_uq UNIQUE (onec_id),
  CONSTRAINT supplier_contracts_kind_check CHECK (kind IN ('supplier', 'buyer', 'other')),
  CONSTRAINT supplier_contracts_site_status_check
    CHECK (site_status IN ('exact', 'group', 'conflict', 'none'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_contracts_inn_idx ON supplier_contracts (counterparty_inn);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_contracts_site_ids_idx ON supplier_contracts USING gin (site_ids);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS supplier_contract_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applied_at timestamptz NOT NULL,
  file_name text NOT NULL,
  file_sha256 text NOT NULL,
  fingerprint text NOT NULL,
  rows_total integer NOT NULL,
  inserted integer NOT NULL,
  updated integer NOT NULL,
  missing integer NOT NULL,
  returned integer NOT NULL,
  reverted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_contract_imports_applied_idx
  ON supplier_contract_imports (applied_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS delivery_contracts (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES supplier_contracts(id) ON DELETE RESTRICT,
  linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_contracts_contract_idx ON delivery_contracts (contract_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS delivery_contract_events (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL,
  contract_id uuid,
  previous_contract_id uuid,
  kind text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_contract_events_kind_check CHECK (kind IN ('linked', 'replaced', 'unlinked'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_contract_events_delivery_idx
  ON delivery_contract_events (delivery_id, id);
