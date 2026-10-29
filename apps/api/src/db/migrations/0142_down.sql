-- Откат 0142: сначала откатить код, потом схему. Признак «Реализация +
-- давальческий» сбрасывается в NULL, иначе старый CHECK не встанет; отметки
-- «Диспетчер» теряются вместе с колонками.
DROP INDEX IF EXISTS deliveries_dispatcher_checked_idx;
--> statement-breakpoint
ALTER TABLE deliveries
  DROP CONSTRAINT IF EXISTS deliveries_dispatcher_check_chk,
  DROP COLUMN IF EXISTS dispatcher_checked_by_user_id,
  DROP COLUMN IF EXISTS dispatcher_checked_at;
--> statement-breakpoint
UPDATE deliveries SET purpose = NULL WHERE purpose = 'realization_tolling';
--> statement-breakpoint
ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_purpose_chk,
  ADD CONSTRAINT deliveries_purpose_chk
  CHECK (purpose IN ('own_forces', 'realization', 'tolling_act', 'contractor_materials'));
