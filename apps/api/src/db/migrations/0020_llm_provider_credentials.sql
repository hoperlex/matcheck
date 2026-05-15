-- Универсальный ключ на тип LLM-провайдера.
--
-- До этой миграции api_key_encrypted хранился per-строка llm_providers.
-- Если админ хотел три модели через OpenRouter — он трижды дублировал
-- один и тот же ключ. Эта таблица хранит ровно один credential на kind:
-- все модели одного типа используют общий ключ. Перенос данных делается
-- автоматически после применения миграции — см. backfill-provider-
-- credentials.ts, вызываемый из scripts/migrate.ts.
CREATE TABLE "llm_provider_credentials" (
	"kind" "llm_kind" PRIMARY KEY NOT NULL,
	"api_base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
