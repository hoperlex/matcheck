-- Волна 1A — недостающие индексы для скорости чтения и каскада удаления.
--
-- Подтверждены статистикой прод-БД (pg_stat_user_tables): по delivery_photos
-- ~50 млрд строк прочитано seq-scan'ом (idx_scan почти не растёт), по
-- delivery_items idx_scan=14 при 2 млн seq_scan. Причина — отсутствие индексов
-- на FK delivery_id/shipment_id/source_document_id и на дочерних source-таблицах.
-- Эти индексы устраняют N+1-сканы в списках приёмок/отгрузок/документов и
-- ускоряют каскадное удаление.
--
-- НЕДЕСТРУКТИВНО: только CREATE INDEX IF NOT EXISTS, данные не меняются, форма
-- ответов API не меняется. Составные индексы фильтрации операций
-- (site_id/status_id/display_id) и trigram-поиск НЕ включены — они кандидаты и
-- вводятся отдельно после EXPLAIN на проде (см. план, Волны 1A-candidate / 1E).
--
-- ПОРЯДОК ВЫКАТА (важно для непрерывности работы планшетов):
--   1) СНАЧАЛА прогнать online-index runner (scripts/create-indexes-online.ts) —
--      он строит те же индексы CONCURRENTLY (не блокирует запись фото/документов).
--   2) ПОТОМ обычный деплой: migrate.ts выполнит этот файл, и CREATE INDEX
--      IF NOT EXISTS увидит уже готовые индексы → мгновенный no-op без блокировки.
-- Если runner не запускался, этот файл всё равно создаст индексы обычным
-- CREATE INDEX (кратковременный SHARE-лок; таблицы малы — доли секунды), но
-- штатный путь — через runner.

CREATE INDEX IF NOT EXISTS "delivery_items_delivery_line_idx" ON "delivery_items" ("delivery_id", "line_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_items_shipment_line_idx" ON "shipment_items" ("shipment_id", "line_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_photos_delivery_idx" ON "delivery_photos" ("delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_photos_shipment_idx" ON "shipment_photos" ("shipment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_sources_source_document_idx" ON "delivery_sources" ("source_document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_sources_source_document_idx" ON "shipment_sources" ("source_document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_document_items_source_document_idx" ON "source_document_items" ("source_document_id", "line_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_document_attachments_source_document_idx" ON "source_document_attachments" ("source_document_id", "role", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_documents_direction_parsed_idx" ON "source_documents" ("direction", "parsed_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_documents_site_direction_parsed_idx" ON "source_documents" ("site_id", "direction", "parsed_at" DESC, "id" DESC);
