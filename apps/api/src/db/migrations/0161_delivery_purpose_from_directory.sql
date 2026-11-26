-- Источник признака приёмки: true — признак поставил справочник
-- «Контрагенты → Объекты и вид» (domain/operations/delivery-purpose.ts), false —
-- человек или прежние правила. Только подставленный признак пересчитывается при
-- смене подрядчика или объекта; ручной выбор не трогается никогда.
-- Все существующие признаки получают false: они считаются ручными и сохраняются.
-- Константный DEFAULT — без перезаписи таблицы (PG 11+), блокировка короткая.
-- CHECK «флаг ⇒ признак не пуст» намеренно нет: путь записи, который его не
-- учёл, отдал бы планшету 500 на upsert (см. delivery-purpose.ts).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS purpose_from_directory boolean NOT NULL DEFAULT false;
