-- Откат 0157: сначала откатить код вкладки «API-доступ».
-- Описание, срок и время последнего обращения ключей откат не переживут.
ALTER TABLE service_accounts
  DROP COLUMN IF EXISTS created_by_user_id,
  DROP COLUMN IF EXISTS last_used_at,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS description;
