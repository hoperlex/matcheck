-- Откат 0137: сначала откатить код импорта справочников, потом схему.
DROP INDEX IF EXISTS suppliers_billhub_id_uq;
--> statement-breakpoint
ALTER TABLE suppliers DROP COLUMN IF EXISTS billhub_id;
