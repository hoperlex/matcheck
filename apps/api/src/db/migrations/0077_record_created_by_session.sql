-- Привязка приёмок и отгрузок к сессии, которая их завела.
--
-- Зачем. На PRIMAVERA К14, ДОМ 56 и ИНДЖОЙ работает по четыре планшета, на
-- АЛИИ, ЗИЛ33 и Событии 6.2 — по три. Если один перестаёт отправлять записи,
-- соседние его полностью маскируют: агрегат по инспектору остаётся в норме, и
-- «немой» планшет невидим. Ни deliveries, ни shipments, ни sessions не несли
-- идентификатора устройства, поэтому случай 24–25.07 на ЗИЛАРТ 18 (шесть
-- приёмок, созданных на сервере за три секунды при разбросанном arrived_at —
-- подпись выгрузки застоявшейся очереди) невозможно было отнести к конкретному
-- планшету.
--
-- Сессия — это одно устройство между логинами, а её last_seen_ua уже содержит
-- версию приложения. Пары «запись → сессия → UA» достаточно, чтобы увидеть, кто
-- именно замолчал, и мобильного релиза для этого не требуется.
--
-- Поле служебное: в /sync и DTO не выводится, контракт не меняется.
-- NULL допустим и осмыслен — исторические записи и парные transfer-приёмки,
-- которые заводит сервер (domain/transfers/pair.ts), а не планшет.
-- ON DELETE SET NULL: удаление сессии не должно уносить за собой документ.

ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "created_by_session_id" uuid
  REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "created_by_session_id" uuid
  REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Составной, а не два отдельных: запросы здоровья парка всегда идут парой
-- «устройство + окно времени». Частичный — записей с NULL большинство
-- (все исторические), в индексе им делать нечего.
CREATE INDEX IF NOT EXISTS "deliveries_created_by_session_idx"
  ON "deliveries" ("created_by_session_id", "created_at")
  WHERE "created_by_session_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shipments_created_by_session_idx"
  ON "shipments" ("created_by_session_id", "created_at")
  WHERE "created_by_session_id" IS NOT NULL;
