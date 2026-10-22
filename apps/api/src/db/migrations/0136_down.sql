-- Откат 0136: связи остаются, теряется только блок — чипы вернутся в шапку.
-- Сначала откатить код, потом схему.
DROP INDEX IF EXISTS "delivery_edo_matches_section_idx";
ALTER TABLE "delivery_edo_matches" DROP COLUMN IF EXISTS "section_document_id";
