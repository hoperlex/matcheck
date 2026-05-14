-- Объекты строительства (площадки), в разрезе которых ведётся приёмка/отгрузка/остатки.
-- Заводим системный объект «Без объекта» с фиксированным UUID, чтобы существующие приёмки
-- (без site_id) можно было дозаполнить им в миграции 0006.

CREATE TABLE "sites" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code"       varchar(5)  NOT NULL,
  "name"       text        NOT NULL,
  "full_name"  text,
  "address"    text,
  "is_active"  boolean     NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "site_code_unique" ON "sites" ("code");
--> statement-breakpoint
CREATE INDEX "site_active_idx" ON "sites" ("name") WHERE "is_active";
--> statement-breakpoint
INSERT INTO "sites" ("id", "code", "name", "full_name", "is_active") VALUES
  ('00000000-0000-0000-0000-000000000001', 'NA', 'Без объекта', 'Системный объект (используется для миграции старых записей)', false);
