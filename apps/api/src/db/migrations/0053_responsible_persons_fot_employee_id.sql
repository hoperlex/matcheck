-- Кэш МОЛ из внешней БД ФОТ (public.mol_persons) в локальной
-- responsible_persons. До этой миграции справочник был полностью
-- локальный: менеджеры заводили МОЛ вручную (UUID id). С этой миграции
-- появляется второй источник — ФОТ; sync-функция UPSERT-ит ФОТ-записи
-- по employeeId в ту же таблицу. Локально созданные МОЛ остаются как
-- были (fot_employee_id IS NULL), записи из ФОТ имеют ненулевой
-- fot_employee_id и не редактируются в MATCHECK (см. routes).
--
-- recipient_mol_id во всех таблицах документов и поставок продолжает
-- указывать на responsible_persons.id (UUID) — никакая FK-логика не
-- ломается, исторические записи живы.

ALTER TABLE responsible_persons
  ADD COLUMN fot_employee_id BIGINT;

-- Уникальный индекс по fot_employee_id (только там, где он есть):
-- partial index — нужен для ON CONFLICT (fot_employee_id) DO UPDATE
-- в sync-функции и одновременно не запрещает много локальных МОЛ
-- с NULL в этом столбце.
CREATE UNIQUE INDEX responsible_persons_fot_employee_id_uidx
  ON responsible_persons (fot_employee_id)
  WHERE fot_employee_id IS NOT NULL;
