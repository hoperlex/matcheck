-- Объекты наблюдателя (роль observer): он видит данные только этих объектов.
--
-- users.site_id не трогаем: это объект инспектора КПП, на нём держится планшет.
-- Пустой список = «не видит ничего», поэтому CASCADE при удалении объекта
-- только сужает доступ и никогда не открывает лишнего.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_sites (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_sites_site_idx ON user_sites (site_id);
