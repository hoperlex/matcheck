-- Учётки СБИС и признаки «один документ» в реестре УПД (этап Р2 подключения СБИС).
--
-- edo_accounts: оператор до сих пор не был ограничен ничем — фиксируем двух
-- (Диадок, СБИС). У СБИС свой режим входа (три ключа приложения), и пара
-- provider/auth_mode проверяется базой: учётка СБИС не может получить режим
-- Диадока и наоборот, а пути Диадока отсекают чужого оператора кодом (dd7b987).
--
-- edo_export_documents: УПД из Диадока и СБИС попадают в один реестр, и одна и та
-- же УПД может прийти через обоих операторов. Признаки тождества копий:
--   - content_sha256 — тот же файл (уже есть);
--   - file_id — ИдФайл из XML: тот же файл, переданный другим путём;
--   - content_key — отпечаток состава (продавец, покупатель, номер, дата, суммы
--     и все позиции): та же УПД, отправленная повторно новым файлом.
-- provider_revision_id — редакция документа СБИС, по которой повторяется
-- скачивание. Колонки заполняет запись реестра; старые строки Диадока —
-- разовый scripts/edo-identity-backfill.ts.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE edo_accounts DROP CONSTRAINT IF EXISTS edo_accounts_auth_mode_chk;
--> statement-breakpoint
ALTER TABLE edo_accounts ADD CONSTRAINT edo_accounts_auth_mode_chk
  CHECK (auth_mode IN ('oidc_refresh', 'developer_key', 'sbis_service_key'));
--> statement-breakpoint
ALTER TABLE edo_accounts ADD CONSTRAINT edo_accounts_provider_chk
  CHECK (provider IN ('diadoc', 'sbis'));
--> statement-breakpoint
ALTER TABLE edo_accounts ADD CONSTRAINT edo_accounts_provider_auth_chk
  CHECK ((provider = 'sbis') = (auth_mode = 'sbis_service_key'));
--> statement-breakpoint
ALTER TABLE edo_export_documents ADD COLUMN IF NOT EXISTS provider_revision_id text;
--> statement-breakpoint
ALTER TABLE edo_export_documents ADD COLUMN IF NOT EXISTS file_id text;
--> statement-breakpoint
ALTER TABLE edo_export_documents ADD COLUMN IF NOT EXISTS content_key varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS edo_export_documents_sha_idx
  ON edo_export_documents (content_sha256) WHERE status = 'stored';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS edo_export_documents_file_id_idx
  ON edo_export_documents (file_id) WHERE status = 'stored' AND file_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS edo_export_documents_content_key_idx
  ON edo_export_documents (content_key) WHERE status = 'stored' AND content_key IS NOT NULL;
