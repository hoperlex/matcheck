-- После 0020 + автоматического backfill ключи живут в llm_provider_credentials,
-- а старые колонки llm_providers.api_key_encrypted и llm_providers.api_base_url
-- больше не источник истины. Снимаем NOT NULL, чтобы новые записи llm_providers
-- можно было создавать без дублирования ключа (UI поле уберём отдельно).
--
-- Сами колонки оставляем как страховку на одну прод-итерацию — DROP-нем
-- следующей миграцией после успешной выкатки.
ALTER TABLE "llm_providers" ALTER COLUMN "api_key_encrypted" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_providers" ALTER COLUMN "api_base_url" DROP NOT NULL;
