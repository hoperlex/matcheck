-- Подрядчик (справочник «Контрагенты») × объект → вид: реализация,
-- давальческий акт или оба. Коды вида совпадают с признаком приёмки
-- (deliveries.purpose), чтобы позже подсказывать «Признак» без пересчёта.
--
-- У каждой группы колонок один писатель:
--   onec_*   — только импорт scripts/import-contractor-sites.ts (выгрузка 1С
--              «Списание по субподряду»);
--   manual_* — только карточка контрагента на портале.
-- Действующий вид = coalesce(manual_kind, onec_kind); manual_kind = 'none' —
-- строка 1С скрыта вручную: не показывается, и повторная загрузка её не вернёт.
-- Скрытая строка без данных 1С не живёт (импорт её удаляет).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_counterparty_sites (
  customer_counterparty_id uuid NOT NULL REFERENCES customer_counterparties (id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  onec_kind varchar(24),
  onec_realization_docs integer,
  onec_realization_sum numeric(16, 2),
  onec_tolling_docs integer,
  onec_tolling_sum numeric(16, 2),
  onec_objects text[] NOT NULL DEFAULT '{}'::text[],
  onec_loaded_at timestamptz,
  manual_kind varchar(24),
  manual_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  manual_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_counterparty_id, site_id),
  CONSTRAINT customer_counterparty_sites_onec_kind_check
    CHECK (onec_kind IS NULL OR onec_kind IN ('realization', 'tolling_act', 'realization_tolling')),
  CONSTRAINT customer_counterparty_sites_manual_kind_check
    CHECK (manual_kind IS NULL OR manual_kind IN ('realization', 'tolling_act', 'realization_tolling', 'none')),
  CONSTRAINT customer_counterparty_sites_has_kind
    CHECK (onec_kind IS NOT NULL OR manual_kind IS NOT NULL),
  CONSTRAINT customer_counterparty_sites_hidden_needs_onec
    CHECK (manual_kind IS DISTINCT FROM 'none' OR onec_kind IS NOT NULL),
  CONSTRAINT customer_counterparty_sites_onec_complete
    CHECK (
      (onec_kind IS NULL) = (onec_realization_docs IS NULL)
      AND (onec_kind IS NULL) = (onec_realization_sum IS NULL)
      AND (onec_kind IS NULL) = (onec_tolling_docs IS NULL)
      AND (onec_kind IS NULL) = (onec_tolling_sum IS NULL)
      AND (onec_kind IS NULL) = (onec_loaded_at IS NULL)
    ),
  CONSTRAINT customer_counterparty_sites_onec_non_negative
    CHECK (
      onec_realization_docs >= 0 AND onec_tolling_docs >= 0
      AND onec_realization_sum >= 0 AND onec_tolling_sum >= 0
    ),
  CONSTRAINT customer_counterparty_sites_manual_at
    CHECK ((manual_kind IS NULL) = (manual_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_counterparty_sites_site_idx
  ON customer_counterparty_sites (site_id);
