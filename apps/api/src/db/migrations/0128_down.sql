-- Откат 0128. Колонки удаляются вместе с данными о сохранённых файлах; сброс
-- poll_enabled не откатывается — прежнее значение неизвестно, а включённый
-- без решения человека опрос опаснее выключенного.
ALTER TABLE "edo_receipts" DROP COLUMN IF EXISTS "size_bytes";
--> statement-breakpoint
ALTER TABLE "edo_receipts" DROP COLUMN IF EXISTS "mime_type";
--> statement-breakpoint
ALTER TABLE "edo_receipts" DROP COLUMN IF EXISTS "original_filename";
