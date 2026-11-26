-- Откат 0160: сначала откатить портал и API (они пишут новый вид). Ручной вид
-- «Материалы подрядчика» теряется: связь, у которой есть данные 1С, снова
-- показывает вид 1С; связь без данных 1С удаляется (без вида она не живёт —
-- CHECK customer_counterparty_sites_has_kind).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM customer_counterparty_sites
 WHERE manual_kind = 'contractor_materials' AND onec_kind IS NULL;
--> statement-breakpoint
UPDATE customer_counterparty_sites
   SET manual_kind = NULL, manual_by_user_id = NULL, manual_at = NULL, updated_at = now()
 WHERE manual_kind = 'contractor_materials';
--> statement-breakpoint
ALTER TABLE customer_counterparty_sites
  DROP CONSTRAINT IF EXISTS customer_counterparty_sites_manual_kind_check;
--> statement-breakpoint
ALTER TABLE customer_counterparty_sites
  ADD CONSTRAINT customer_counterparty_sites_manual_kind_check
  CHECK (manual_kind IS NULL OR manual_kind IN ('realization', 'tolling_act', 'realization_tolling', 'none'));
