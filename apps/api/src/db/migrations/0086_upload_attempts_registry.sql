-- Постоянный реестр входных файлов и явная попытка загрузки.
--
-- Зачем. Сейчас перечень принятых файлов живёт только в attachments служебной
-- записи пакета, а она удаляется в конце разбора — вместе с attachments по
-- каскаду. Журнал bundle_import_items при этом очищается в начале КАЖДОГО
-- прогона router'а. Итог: файл, упавший при разборе, не оставляет следов —
-- пакет помечается parsed, поставщик видит «принято», а документа нет и
-- перезапустить нечего. Реестр делает строку на файл постоянной.
--
-- Вторая половина — состояние попытки загрузки. Между резервированием пакета и
-- финальной транзакцией лежит заливка в S3; если процесс умрёт внутри этого
-- окна, пакет остаётся queued, а ключи объектов не записаны нигде — чистить
-- нечего, листинга по префиксу в коде нет. Теперь ключи известны сразу после
-- первой транзакции, а попытка имеет явные состояния uploading → accepted |
-- abandoned и lease владельца.
--
-- Всё аддитивно и nullable: старый образ продолжает работать на новой схеме.
-- NOT NULL на input_s3_key навесит contract-миграция, когда все writers
-- перейдут на новый формат.

ALTER TABLE "source_bundles"
  ADD COLUMN IF NOT EXISTS "active_upload_generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Попытка загрузки пакета. Поколение выделяется инкрементом
-- source_bundles.active_upload_generation внутри транзакции: блокировка строки
-- пакета сериализует конкурентов, поэтому номер уникален без отдельного
-- счётчика. Оно же входит в S3-путь — иначе отложенная чистка брошенной
-- попытки удалила бы файлы повторной загрузки: ключи детерминированы и
-- совпали бы.
CREATE TABLE IF NOT EXISTS "bundle_upload_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  -- uploading | accepted | abandoned
  "state" text NOT NULL DEFAULT 'uploading',
  -- До какого момента попытка считается живой. Продлевается по ходу заливки;
  -- по истечении конкурент вправе выполнить takeover.
  "lease_until" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bundle_upload_attempts_generation_unique"
  ON "bundle_upload_attempts" ("bundle_id", "generation");
--> statement-breakpoint
-- Sweeper ищет только просроченные незавершённые попытки.
CREATE INDEX IF NOT EXISTS "bundle_upload_attempts_stale_idx"
  ON "bundle_upload_attempts" ("lease_until")
  WHERE "state" = 'uploading';
--> statement-breakpoint

-- Реестр входных файлов: bundle_import_items перестаёт быть журналом одного
-- прогона и становится постоянным перечнем принятого.
ALTER TABLE "bundle_import_items"
  ADD COLUMN IF NOT EXISTS "input_s3_key" text,
  ADD COLUMN IF NOT EXISTS "mime_type" varchar(255),
  ADD COLUMN IF NOT EXISTS "size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "upload_generation" integer,
  -- Накладная разворачивается в ДОЧЕРНИЙ пакет, поэтому у итогового документа
  -- bundle_id уже не родительский — связь на sub-пакет нужна явная.
  ADD COLUMN IF NOT EXISTS "sub_bundle_id" uuid REFERENCES "source_bundles"("id") ON DELETE SET NULL,
  -- КОНЕЧНОЕ состояние файла. status говорит лишь о решении router'а: created
  -- означает «дочернее задание поставлено», а документ после этого ещё может
  -- уйти в parse_failed. Счётчики и «Требует внимания» смотрят сюда.
  ADD COLUMN IF NOT EXISTS "effective_status" text,
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "resolved_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- Документ, заведённый менеджером вручную по этому файлу.
  ADD COLUMN IF NOT EXISTS "manual_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Ключ upsert'а вместо delete+insert. Индекс частичный, поэтому существующие
-- строки (у всех input_s3_key = NULL) под него не попадают и конфликтовать не
-- могут — создавать его до backfill безопасно. Legacy-строки так и остаются с
-- NULL: восстановить их ключи неоткуда, attachments служебных записей давно
-- удалены.
CREATE UNIQUE INDEX IF NOT EXISTS "bundle_import_items_input_file_unique"
  ON "bundle_import_items" ("bundle_id", "input_s3_key", "upload_generation")
  WHERE "input_s3_key" IS NOT NULL;
--> statement-breakpoint
-- Выборка непрошедших файлов для раздела «Требует внимания».
CREATE INDEX IF NOT EXISTS "bundle_import_items_unresolved_idx"
  ON "bundle_import_items" ("effective_status")
  WHERE "effective_status" IS NOT NULL AND "resolved_at" IS NULL;
--> statement-breakpoint

-- Флаг ставит ТОЛЬКО сторож/recovery. Обычная доставка сохраняет семантику
-- «задание с таким jobId уже есть — значит доставлено»: если снимать любой
-- завершённый job, то падение между queue.add и удалением строки outbox
-- приведёт к повторному выполнению уже отработавшего задания.
ALTER TABLE "job_outbox"
  ADD COLUMN IF NOT EXISTS "replace_terminal" boolean NOT NULL DEFAULT false;
