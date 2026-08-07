-- Происхождение получателя inbound-документа.
--
-- Зачем. Документы с публичной страницы /uploads приходят без получателя:
-- поставщик подрядчика не знает, и в форме его не спрашивают. Из-за этого они
-- вечно висят «Черновиком», пока менеджер не дозаполнит карточку руками.
-- Резолвер подставляет подрядчика по ИНН покупателя (графа 6 УПД), а эта
-- колонка помнит, кто именно проставил получателя.
--
-- Почему не хватает «contractor_id IS NULL». Это условие не отличает «никто ещё
-- не выбирал» от «менеджер сознательно очистил автоподстановку»: второй проход
-- распознавания вернул бы подрядчика обратно, перечеркнув решение человека.
-- Три состояния разводят эти случаи:
--   NULL         — получателя не задавали ни человек, ни автоматика;
--   'manual'     — задал человек: подрядчик, МОЛ или явная очистка поля;
--   'auto_buyer' — подставил резолвер из покупателя.
--
-- Почему recipient_source, а не contractor_source. 'manual' выставляется и при
-- выборе МОЛ, то есть поле описывает происхождение ПОЛУЧАТЕЛЯ, а не только
-- подрядчика.
--
-- Только для direction='inbound'. У outbound получатель — recipient_id, а
-- contractor_id там наш отправитель, и «Черновиком» документ из-за него не
-- становится (см. getDocumentDisplayStatus). Без этого ограничения
-- outbound-документы получили бы 'manual' из-за отправителя.
--
-- ВАЖНО про RBAC: 'auto_buyer' снимает «Черновик», но НЕ является основанием
-- для доступа роли contractor — содержимое публично загруженного файла
-- недоверенное. Ограничение живёт в lib/contractor-scope.ts и снимается, когда
-- появятся именные ссылки загрузки.
--
-- Аддитивно и nullable: старый образ продолжает работать на новой схеме.

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "recipient_source" text;
--> statement-breakpoint
-- CHECK отдельным шагом: NOT VALID не нужен, таблица маленькая, а список
-- значений закрытый — мусор в колонке сломал бы RBAC-предикат молча.
ALTER TABLE "source_documents"
  DROP CONSTRAINT IF EXISTS "source_documents_recipient_source_check";
--> statement-breakpoint
ALTER TABLE "source_documents"
  ADD CONSTRAINT "source_documents_recipient_source_check"
  CHECK ("recipient_source" IS NULL OR "recipient_source" IN ('manual', 'auto_buyer'));
--> statement-breakpoint
-- Бэкфилл. Всё, что уже имеет получателя, проставил человек: до этой миграции
-- автоматики не существовало. Строго inbound — по причине выше.
UPDATE "source_documents"
   SET "recipient_source" = 'manual'
 WHERE "direction" = 'inbound'
   AND "recipient_source" IS NULL
   AND ("contractor_id" IS NOT NULL OR "recipient_mol_id" IS NOT NULL);
