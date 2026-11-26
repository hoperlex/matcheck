-- Откат 0161: сначала откатить API (он пишет и читает колонку). Подставленные
-- признаки остаются как есть — после отката они неотличимы от ручных.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE deliveries DROP COLUMN IF EXISTS purpose_from_directory;
