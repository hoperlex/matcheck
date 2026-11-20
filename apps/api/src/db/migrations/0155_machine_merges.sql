-- Объединение машин: несколько отправок с /uploads — одна поставка.
--
-- Машина («поставка») до сих пор нигде не хранилась: её вычисляли как корневой
-- пакет загрузки, coalesce(parent_bundle_id, id). Если сотрудник отправил
-- документы одного рейса разными «Машинами» (каждую страницу отдельно, УПД
-- отдельно от накладной), у инспектора выходило несколько карточек, и рейс
-- оформлялся несколько раз. Менеджер исправляет это на портале кнопкой
-- «Объединить в одну машину» — здесь хранится результат.
--
-- Документы, позиции и файлы при этом НЕ меняются: объединение — отдельная
-- запись «отправка-участник → отправка-голова». Снять её — удалить строки.
--
-- Голова машины = coalesce(target_root_id участника, собственный корень).
-- Инвариант «без цепочек»: голова никогда не стоит в member_root_id. Его
-- держит код слияния под замком машины (domain/sourceDocuments/machine-merge.ts),
-- СУБД здесь проверяет только «не сам на себя».
--
-- merge_id — операция, которой участник попал в машину. Нужен «Отменить»:
-- отмена снимает объединение, только если состав машины всё ещё ровно тот,
-- что создала эта операция, а не чужой, добавленный позже.
--
-- НЕДЕСТРУКТИВНО: новая таблица. Старый код её не читает, строк в ней нет,
-- пока объединение не включено (MACHINE_MERGE_SITES пуст) — поведение API на
-- окне выката прежнее. Откат: 0155_down.sql (сначала снять объединения
-- скриптом machine-merges-retire.ts, см. план).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "machine_merges" (
  "member_root_id" uuid PRIMARY KEY REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "target_root_id" uuid NOT NULL REFERENCES "source_bundles"("id") ON DELETE CASCADE,
  "merge_id" uuid NOT NULL,
  "merged_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "merged_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "machine_merges_not_self_check" CHECK ("member_root_id" <> "target_root_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_merges_target_idx" ON "machine_merges" ("target_root_id");
--> statement-breakpoint
-- Событие «override» в журнале claim'ов: менеджер на портале осознанно привязал
-- документ занятой машины ко второй операции (allowSecondOperation). Таблица на
-- бою пуста — протокол занятия до сих пор не подключён, — поэтому проверка
-- нового ограничения мгновенна.
ALTER TABLE "operation_group_claim_events"
  DROP CONSTRAINT IF EXISTS "operation_group_claim_events_event_check";
--> statement-breakpoint
ALTER TABLE "operation_group_claim_events"
  ADD CONSTRAINT "operation_group_claim_events_event_check"
  CHECK ("event" IN ('create', 'release', 'reclaim', 'override'));
--> statement-breakpoint
-- Что умеет клиент сессии — значение заголовка X-Matcheck-Capabilities при
-- последнем входе/обновлении токена. По нему портал отказывает в объединении
-- на объекте, где ещё работают планшеты старой сборки: их черновики при смене
-- состава машины теряются. NULL — клиент заголовка не присылал (старая сборка
-- или портал до выпуска). Колонка nullable без значения по умолчанию —
-- изменение только метаданных.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_seen_capabilities" text;
