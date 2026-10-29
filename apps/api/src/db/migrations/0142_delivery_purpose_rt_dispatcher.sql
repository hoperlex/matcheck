-- Пятый признак приёмки «Реализация + давальческий» и отметка «Диспетчер».
-- Отметка независима от отметки проверки (review_*): своя пара «когда / кто»,
-- снимается обратно в NULL. version и updated_at её не касаются.
ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_purpose_chk,
  ADD CONSTRAINT deliveries_purpose_chk
  CHECK (purpose IN ('own_forces', 'realization', 'tolling_act', 'contractor_materials', 'realization_tolling'));
--> statement-breakpoint
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS dispatcher_checked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS dispatcher_checked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT deliveries_dispatcher_check_chk
  CHECK (dispatcher_checked_by_user_id IS NULL OR dispatcher_checked_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deliveries_dispatcher_checked_idx
  ON deliveries (dispatcher_checked_at) WHERE dispatcher_checked_at IS NOT NULL;
