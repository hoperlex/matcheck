-- Флаг «ОС» (основные средства) для приёмок и отгрузок.
--
-- ЛОГИКА:
--   Инспектор на 1 Этапе мобилы отмечает чекбокс «ОС», если по этой накладной
--   приходят/уходят объекты основных средств (а не материалы). На веб-портале
--   рядом с бейджем «Транзит» появляется бейдж «ОС». Поле полностью
--   ортогонально статусу/типу: используется для визуальной фильтрации и
--   будущей отчётности по движению ОС.
--
-- СОВМЕСТИМОСТЬ:
--   * ADD COLUMN с default false не блокирует таблицу (PostgreSQL 11+ —
--     metadata-only change), не пересчитывает строки.
--   * NOT NULL DEFAULT false — все существующие записи получают `false`
--     автоматически без перезаписи (отчёты/списки не поменяются).
--   * Старые мобильные клиенты, которые поле не шлют, сервер trеатит как
--     undefined → false (zod default). Старые DTO ответов сервера новое поле
--     получат с false → парсер на старых клиентах его проигнорирует
--     (ignoreUnknownKeys=true в Kotlin Json).
--
-- ОТКАТ:
--   ALTER TABLE deliveries DROP COLUMN is_assets;
--   ALTER TABLE shipments  DROP COLUMN is_assets;

ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "is_assets" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "is_assets" boolean NOT NULL DEFAULT false;
