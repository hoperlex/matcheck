-- Откат 0082: возвращаем контактные колонки, убираем комментарий.
--
-- Данные комментариев при откате теряются — их некуда положить. Откатывать
-- имеет смысл только вместе с кодом: форма без этих колонок работать не будет,
-- а старая форма без комментария писала имя и телефон.

ALTER TABLE "ingest_events"
  ADD COLUMN IF NOT EXISTS "submitter_name" text,
  ADD COLUMN IF NOT EXISTS "submitter_phone" text;
--> statement-breakpoint
ALTER TABLE "ingest_events" DROP COLUMN IF EXISTS "submission_comment";
