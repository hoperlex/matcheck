-- Разделение входящих документов на направления: «Приёмка» (inbound)
-- и «Отгрузка» (outbound). См. apps/api/src/db/schema.ts (sourceDirectionEnum).
-- Все существующие записи получают direction='inbound' через DEFAULT —
-- исторически /documents использовался только для приёмочных УПД и заявок.

CREATE TYPE "source_direction" AS ENUM ('inbound', 'outbound');

ALTER TABLE "source_documents"
  ADD COLUMN "direction" "source_direction" NOT NULL DEFAULT 'inbound';

CREATE INDEX "source_direction_idx" ON "source_documents" ("direction");
