-- Откат 0124.
--
-- Возврат прежнего уникального индекса возможен ТОЛЬКО если ни одно сообщение
-- не принесло больше одного документа: иначе парный индекс не построится, а
-- «починить» его можно лишь удалением документов. Молча терять данные при
-- откате недопустимо, поэтому проверка явная и падает с внятным текстом.
DO $$
DECLARE dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1
      FROM source_documents
     WHERE edo_account_id IS NOT NULL
     GROUP BY edo_account_id, provider_message_id
    HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION
      'Откат 0124 невозможен: % сообщений ЭДО несут более одного документа. Разберите их вручную, иначе откат удалит документы.', dup;
  END IF;
END $$;

DROP INDEX IF EXISTS "source_edo_message_unique";
CREATE UNIQUE INDEX "source_edo_message_unique"
  ON "source_documents" ("edo_account_id", "provider_message_id")
  WHERE "edo_account_id" IS NOT NULL;

ALTER TABLE "source_documents" DROP COLUMN IF EXISTS "provider_entity_id";

DROP TABLE IF EXISTS "edo_receipts";
DROP TABLE IF EXISTS "edo_events";

ALTER TABLE "edo_accounts" DROP CONSTRAINT IF EXISTS "edo_accounts_auth_mode_chk";
ALTER TABLE "edo_accounts" DROP CONSTRAINT IF EXISTS "edo_accounts_environment_chk";
ALTER TABLE "edo_accounts"
  DROP COLUMN IF EXISTS "poll_enabled",
  DROP COLUMN IF EXISTS "poll_lease_owner",
  DROP COLUMN IF EXISTS "poll_lease_token",
  DROP COLUMN IF EXISTS "poll_lease_until",
  DROP COLUMN IF EXISTS "auth_mode",
  DROP COLUMN IF EXISTS "auth_state_encrypted",
  DROP COLUMN IF EXISTS "auth_state_version",
  DROP COLUMN IF EXISTS "refresh_token_used_at",
  DROP COLUMN IF EXISTS "environment",
  DROP COLUMN IF EXISTS "box_id",
  DROP COLUMN IF EXISTS "org_inn",
  DROP COLUMN IF EXISTS "last_index_key",
  DROP COLUMN IF EXISTS "last_event_at",
  DROP COLUMN IF EXISTS "backfill_since",
  DROP COLUMN IF EXISTS "default_site_id",
  DROP COLUMN IF EXISTS "last_ok_at",
  DROP COLUMN IF EXISTS "last_error",
  DROP COLUMN IF EXISTS "last_inventory",
  DROP COLUMN IF EXISTS "last_inventory_at";
