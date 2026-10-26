-- Откат 0139: сначала откатить код этапа Р2 (выгрузку СБИС, двойники), потом схему.
-- Учётки и строки СБИС откат не переживут — откатывать только если их нет.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM edo_accounts WHERE provider <> 'diadoc' OR auth_mode = 'sbis_service_key') THEN
    RAISE EXCEPTION 'Откат 0139 невозможен: есть учётки СБИС — сначала удалите их и их строки реестра';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS edo_export_documents_content_key_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS edo_export_documents_file_id_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS edo_export_documents_sha_idx;
--> statement-breakpoint
ALTER TABLE edo_export_documents DROP COLUMN IF EXISTS content_key;
--> statement-breakpoint
ALTER TABLE edo_export_documents DROP COLUMN IF EXISTS file_id;
--> statement-breakpoint
ALTER TABLE edo_export_documents DROP COLUMN IF EXISTS provider_revision_id;
--> statement-breakpoint
ALTER TABLE edo_accounts DROP CONSTRAINT IF EXISTS edo_accounts_provider_auth_chk;
--> statement-breakpoint
ALTER TABLE edo_accounts DROP CONSTRAINT IF EXISTS edo_accounts_provider_chk;
--> statement-breakpoint
ALTER TABLE edo_accounts DROP CONSTRAINT IF EXISTS edo_accounts_auth_mode_chk;
--> statement-breakpoint
ALTER TABLE edo_accounts ADD CONSTRAINT edo_accounts_auth_mode_chk
  CHECK (auth_mode IN ('oidc_refresh', 'developer_key'));
