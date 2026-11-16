-- Группы приёмок: несколько рейсов одной поставки (одна УПД — 2–3 машины).
--
-- Только портал: /sync, upsert планшета и строки deliveries группу не видят.
-- Колонки в deliveries нет намеренно: смена членства не трогает
-- deliveries.version/updated_at, планшет не получает лишней дельты и не ловит 409.
--
-- Инварианты держит код (domain/operations/delivery-groups.ts), а не база:
--  * приёмка не больше чем в одной группе — PK delivery_id;
--  * все члены стоят на site_id группы — сбор группы и upsert со сменой
--    объекта (выводит приёмку из группы);
--  * в группе не меньше двух членов — каждый путь, уменьшающий группу,
--    распускает её в той же транзакции;
--  * член — только живая приёмка: пометка на удаление выводит из группы.
-- Порядок блокировок на всех путях: deliveries → delivery_groups → участники.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS delivery_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS delivery_group_members (
  delivery_id uuid PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES delivery_groups (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS delivery_group_members_group_idx ON delivery_group_members (group_id);
