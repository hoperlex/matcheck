-- Роль пользователя «подрядчик» (contractor) + привязка пользователя к
-- подрядчику из справочника заказчика.
--
-- Зачем: авторизованный подрядчик видит на портале ТОЛЬКО свои приёмки/
-- отгрузки/документы (read-only), по всем объектам. Скоупинг видимости по
-- подрядчику — аналог существующего скоупинга inspector_kpp по siteId.
--
-- Связь идёт на customer_counterparties (чистый справочник заказчика), а не на
-- операционную counterparties: один реальный подрядчик = один ИНН = несколько
-- операционных строк (дубли). Разворот customer→operational по нормализованному
-- ИНН делается в рантайме (expandCustomerCounterpartyToOpIds), тот же механизм,
-- что у UI-фильтра «Подрядчик».
--
-- Значение enum 'contractor' в этой миграции НЕ используется в DDL (колонка —
-- FK на customer_counterparties, не на enum), поэтому ADD VALUE в одной
-- транзакции с ALTER TABLE безопасен (нет 55P04). Строки роли contractor
-- вставляются позже, в отдельных транзакциях.
--
-- Откат: колонку/индекс можно удалить; удалить value из enum PostgreSQL
-- штатно не умеет — при откате оставляем неиспользуемое значение.

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'contractor';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "contractor_customer_id" uuid REFERENCES "customer_counterparties"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_contractor_customer_idx" ON "users" ("contractor_customer_id") WHERE "contractor_customer_id" IS NOT NULL;
