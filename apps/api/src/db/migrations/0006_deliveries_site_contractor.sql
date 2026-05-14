-- Приёмка ведётся в разрезе объекта (site_id обязательно).
-- При поступлении опционально указывается подрядчик (contractor_id) — для кого ввезён материал.
-- Существующие записи заполняются системным объектом «Без объекта»; админу нужно вручную
-- проставить корректный site_id у исторических приёмок (см. /references/sites).

ALTER TABLE "deliveries"
  ADD COLUMN "site_id"       uuid REFERENCES "sites"("id") ON DELETE RESTRICT,
  ADD COLUMN "contractor_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL;
--> statement-breakpoint
UPDATE "deliveries"
  SET "site_id" = '00000000-0000-0000-0000-000000000001'
  WHERE "site_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "site_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "deliveries_site_idx" ON "deliveries" ("site_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "deliveries_contractor_idx" ON "deliveries" ("contractor_id") WHERE "contractor_id" IS NOT NULL;
