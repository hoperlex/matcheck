-- Приём входящих УПД из Контур.Диадок: состояние опроса и журналы.
--
-- Почему две таблицы, а не одна. Курсор ленты и разбор вложений — разные
-- сущности, и смешивать их нельзя:
--   * событие ленты может нести сообщение либо патч к нему, и патч вообще может
--     не содержать нового документа;
--   * одна и та же сущность встречается в нескольких событиях;
--   * ключ (учётная запись, сообщение, сущность) состояния СОБЫТИЯ не выражает.
-- Если считать курсор по журналу сущностей, он либо застрянет, либо перескочит
-- событие — то есть документ пропадёт молча. Поэтому edo_events отвечает за
-- продвижение курсора, edo_receipts — за судьбу каждого вложения.
--
-- НЕДЕСТРУКТИВНО: новые таблицы и только nullable-колонки (либо с DEFAULT).
-- Единственное изменение существующего объекта — замена уникального индекса на
-- source_documents, и новый индекс СТРОГО СЛАБЕЕ прежнего (см. ниже).

-- ── Учётная запись ЭДО ──────────────────────────────────────────────────────

ALTER TABLE "edo_accounts"
  -- Опрос включается ОТДЕЛЬНО от is_active: учётную запись заводят и проверяют
  -- до того, как её начнёт опрашивать воркер. Вторая независимая защита —
  -- переменная окружения EDO_POLL_ENABLED.
  ADD COLUMN IF NOT EXISTS "poll_enabled" boolean NOT NULL DEFAULT false,
  -- Лиз владения: опрашивать учётную запись может только один экземпляр.
  -- Снять или продлить лиз вправе лишь владелец токена.
  ADD COLUMN IF NOT EXISTS "poll_lease_owner" uuid,
  ADD COLUMN IF NOT EXISTS "poll_lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "poll_lease_until" timestamptz,
  ADD COLUMN IF NOT EXISTS "auth_mode" text NOT NULL DEFAULT 'oidc_refresh',
  -- Состояние авторизации (ротируемый refresh_token и кеш access_token) лежит
  -- ОТДЕЛЬНО от введённых человеком секретов: иначе правка названия учётной
  -- записи в админке затирала бы живой токен, а восстановить его можно только
  -- руками через браузер.
  ADD COLUMN IF NOT EXISTS "auth_state_encrypted" text,
  -- Счётчик для compare-and-swap: обмен refresh_token допускается только если
  -- состояние не менялось с момента чтения.
  ADD COLUMN IF NOT EXISTS "auth_state_version" integer NOT NULL DEFAULT 0,
  -- Когда refresh_token последний раз использовали. Он живёт 30 дней, и счётчик
  -- продлевается при каждом использовании: учётная запись с выключенным опросом
  -- умирает молча, поэтому возраст показывается в админке.
  ADD COLUMN IF NOT EXISTS "refresh_token_used_at" timestamptz,
  -- Площадка именем, а не адресом: базовый URL и scope живут в коде. Свободная
  -- строка сделала бы админку источником адреса исходящего запроса.
  ADD COLUMN IF NOT EXISTS "environment" text NOT NULL DEFAULT 'production',
  ADD COLUMN IF NOT EXISTS "box_id" text,
  ADD COLUMN IF NOT EXISTS "org_inn" varchar(12),
  -- Курсор ленты. Именно IndexKey: afterEventId в V8 устарел.
  ADD COLUMN IF NOT EXISTS "last_index_key" text,
  ADD COLUMN IF NOT EXISTS "last_event_at" timestamptz,
  -- Отсечка первичной загрузки. Фиксируется при заведении учётной записи и
  -- уходит в САМ запрос к Диадоку, поэтому история ящика не перебирается.
  ADD COLUMN IF NOT EXISTS "backfill_since" timestamptz,
  -- Объект по умолчанию — для случая «один ящик обслуживает один объект».
  ADD COLUMN IF NOT EXISTS "default_site_id" uuid REFERENCES "sites"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "last_ok_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_error" text,
  -- Отчёт разведки ящика: сколько каких документов там лежит. Нужен, чтобы
  -- решение «включать ли разбор неформализованных» принималось по фактам.
  ADD COLUMN IF NOT EXISTS "last_inventory" jsonb,
  ADD COLUMN IF NOT EXISTS "last_inventory_at" timestamptz;

ALTER TABLE "edo_accounts" DROP CONSTRAINT IF EXISTS "edo_accounts_auth_mode_chk";
ALTER TABLE "edo_accounts"
  ADD CONSTRAINT "edo_accounts_auth_mode_chk"
  CHECK ("auth_mode" IN ('oidc_refresh', 'developer_key'));

ALTER TABLE "edo_accounts" DROP CONSTRAINT IF EXISTS "edo_accounts_environment_chk";
ALTER TABLE "edo_accounts"
  ADD CONSTRAINT "edo_accounts_environment_chk"
  CHECK ("environment" IN ('production', 'staging'));

COMMENT ON COLUMN "edo_accounts"."auth_state_encrypted" IS
  'Ротируемое состояние авторизации (refresh_token, кеш access_token). Отдельно от credentials_encrypted: правка учётной записи не должна затирать живой токен.';
COMMENT ON COLUMN "edo_accounts"."last_index_key" IS
  'Курсор ленты GetNewEvents (IndexKey последнего непрерывно обработанного события). Пишется только под своим токеном лиза.';
COMMENT ON COLUMN "edo_accounts"."backfill_since" IS
  'Отсечка первичной загрузки: передаётся в запрос к Диадоку. Фиксируется при заведении и не пересчитывается.';

-- ── Журнал событий ленты: по нему двигается курсор ──────────────────────────

CREATE TABLE IF NOT EXISTS "edo_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "edo_account_id" uuid NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "event_id"       text NOT NULL,
  "index_key"      text NOT NULL,
  -- 'message' — событие с сообщением, 'patch' — изменение уже доставленного.
  "kind"           text NOT NULL DEFAULT 'message',
  "event_at"       timestamptz,
  -- Терминальные статусы разрешают курсору пройти событие:
  --   processed      — все релевантные сущности доведены до терминала;
  --   no_entities    — в событии нечего забирать (служебный патч, исходящее);
  --   skipped_by_age — событие старше отсечки первичной загрузки;
  --   failed         — исчерпаны попытки по самому событию.
  -- Нетерминальный 'pending' останавливает продвижение курсора на себе.
  "status"         text NOT NULL DEFAULT 'pending',
  "attempts"       integer NOT NULL DEFAULT 0,
  "last_error"     text,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "edo_events_status_chk" CHECK ("status" IN
    ('pending', 'processed', 'no_entities', 'skipped_by_age', 'failed')),
  CONSTRAINT "edo_events_kind_chk" CHECK ("kind" IN ('message', 'patch'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "edo_events_account_event_unique"
  ON "edo_events" ("edo_account_id", "event_id");
CREATE INDEX IF NOT EXISTS "edo_events_account_status_idx"
  ON "edo_events" ("edo_account_id", "status", "created_at");

-- ── Журнал вложений: судьба каждого документа ───────────────────────────────

CREATE TABLE IF NOT EXISTS "edo_receipts" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "edo_account_id" uuid NOT NULL REFERENCES "edo_accounts"("id") ON DELETE CASCADE,
  "event_id"       text,
  "message_id"     text NOT NULL,
  "entity_id"      text NOT NULL,
  "document_type"      text,
  "document_function"  text,
  "document_version"   text,
  "document_number"    text,
  "document_date"      timestamp,
  "counteragent_box_id" text,
  "received_at"    timestamptz,
  -- ТРАНСПОРТ: удалось ли забрать и сохранить файл. Именно это поле решает,
  -- терминальна ли сущность для КУРСОРА.
  --   fetching   — попытка захвачена, идёт скачивание (нетерминально);
  --   stored     — файл лежит в хранилище;
  --   skipped    — забирать нечего (не наш документ, исходящее, служебное);
  --   too_large  — превысил предел размера;
  --   encrypted  — зашифрован, расшифровать нечем;
  --   vanished   — документа больше нет на стороне Диадока (404/410);
  --   failed     — исчерпаны попытки.
  "transport_status" text NOT NULL DEFAULT 'fetching',
  -- МАРШРУТИЗАЦИЯ: что делать с файлом дальше. Отделена от транспорта намеренно.
  -- Пока разбор неформализованных выключен, такие вложения ждут в 'awaiting' —
  -- и это НЕ должно мешать курсору идти дальше, иначе первое же вложение
  -- застопорило бы весь ящик и следующие за ним УПД не импортировались бы.
  --   none        — маршрут ещё не определён;
  --   imported    — формализованный УПД разобран, карточка создана;
  --   awaiting    — неформализованный файл ждёт включения разбора;
  --   routed      — отправлен в конвейер распознавания;
  --   duplicate   — документ уже был импортирован ранее;
  --   not_applicable — маршрут неприменим (нечего разбирать).
  "route_status"   text NOT NULL DEFAULT 'none',
  "attempts"       integer NOT NULL DEFAULT 0,
  "last_error"     text,
  "raw_s3_key"     text,
  "content_sha256" varchar(64),
  -- Чем разобрали: 'local_xml' или 'diadoc_title'. Нужно, чтобы чинить парсер
  -- по фактам, а не по догадкам.
  "parse_source"   text,
  "source_document_id" uuid REFERENCES "source_documents"("id") ON DELETE SET NULL,
  -- Ручной дозабор вложения, по которому транспорт исчерпал попытки.
  "replay_requested_at" timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "edo_receipts_transport_chk" CHECK ("transport_status" IN
    ('fetching', 'stored', 'skipped', 'too_large', 'encrypted', 'vanished', 'failed')),
  CONSTRAINT "edo_receipts_route_chk" CHECK ("route_status" IN
    ('none', 'imported', 'awaiting', 'routed', 'duplicate', 'not_applicable'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "edo_receipts_entity_unique"
  ON "edo_receipts" ("edo_account_id", "message_id", "entity_id");
CREATE INDEX IF NOT EXISTS "edo_receipts_account_transport_idx"
  ON "edo_receipts" ("edo_account_id", "transport_status", "created_at");
-- Очередь дозабора после включения разбора неформализованных.
CREATE INDEX IF NOT EXISTS "edo_receipts_awaiting_idx"
  ON "edo_receipts" ("edo_account_id", "created_at")
  WHERE "route_status" = 'awaiting';

-- ── Документ: сущность, а не сообщение ──────────────────────────────────────

-- Одно сообщение Диадока может нести НЕСКОЛЬКО документов. Прежний уникальный
-- индекс по паре (учётная запись, сообщение) пропускал только первый из них —
-- второй молча не вставлялся бы, то есть документ терялся без следа.
--
-- Замена безопасна: у существующих строк provider_entity_id = '', поэтому
-- тройка вырождается в прежнюю пару. Новый индекс строго слабее старого и не
-- может отвергнуть ни одной уже сохранённой строки.
ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "provider_entity_id" text NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "source_edo_message_unique";
CREATE UNIQUE INDEX "source_edo_message_unique"
  ON "source_documents" ("edo_account_id", "provider_message_id", "provider_entity_id")
  WHERE "edo_account_id" IS NOT NULL;

COMMENT ON COLUMN "source_documents"."provider_entity_id" IS
  'Идентификатор сущности (вложения) внутри сообщения ЭДО. Пустая строка — записи, созданные до 0124, и все не-ЭДО документы.';
