-- Машинные ключи из портала: вкладка «Администрирование → API-доступ».
--
-- description        — «кому выдан и зачем», свободный текст.
-- expires_at         — срок действия; NULL — бессрочно. Проверяется и при выдаче
--                      токена, и на каждом запросе: истёкший ключ перестаёт
--                      работать сразу, а не через 10 минут жизни токена.
-- last_used_at       — последнее обращение с токеном ключа. Пишется не чаще раза
--                      в минуту (условный UPDATE), чтобы не писать на каждый запрос.
-- created_by_user_id — кто выдал ключ из портала (у ключей из командной строки NULL).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE service_accounts
  ADD COLUMN description text,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN last_used_at timestamptz,
  ADD COLUMN created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;
