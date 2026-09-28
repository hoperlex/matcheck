-- Квитанция ЭДО помнит, что именно сохранено; опрос выключается до импорта.
--
-- Зачем колонки. Вложение из Диадока сохранялось в хранилище под именем `.xml`
-- и с типом application/xml независимо от содержимого, а квитанция не хранила
-- ни исходного имени, ни типа, ни размера. PDF или скан, забранный так, позже
-- нельзя ни распознать, ни переразобрать: неизвестно даже, что это за файл.
--
-- Зачем сброс poll_enabled. Импорт теперь закрыт выключателем
-- EDO_IMPORT_ENABLED, и пока он выключен, API не даёт включить опрос. Но
-- сохранённое раньше `true` сработало бы само в момент будущего включения
-- импорта — то есть опрос начался бы следствием деплоя, а не решением
-- человека. На бою на 25.09.2026 у единственной учётной записи уже `false`.
--
-- НЕДЕСТРУКТИВНО: три nullable-колонки; сброс флага, который и так выключен.

ALTER TABLE "edo_receipts" ADD COLUMN IF NOT EXISTS "original_filename" text;
--> statement-breakpoint
ALTER TABLE "edo_receipts" ADD COLUMN IF NOT EXISTS "mime_type" varchar(100);
--> statement-breakpoint
ALTER TABLE "edo_receipts" ADD COLUMN IF NOT EXISTS "size_bytes" integer;
--> statement-breakpoint
UPDATE "edo_accounts" SET "poll_enabled" = false, "updated_at" = now() WHERE "poll_enabled" = true;
