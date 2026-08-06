-- Стороны документа: покупатель и грузополучатель из шапки УПД.
--
-- Зачем. В списке Документов колонка «Подрядчик» показывала contractor_id —
-- то, что менеджер выбрал руками при загрузке, а не то, что написано в
-- документе. У документов с публичной страницы /uploads она пуста всегда:
-- поставщик подрядчика не знает и в форме его не выбирает.
--
-- Переиспользовать существующие колонки нельзя:
--   * contractor_id — операционный подрядчик; на нём права роли contractor,
--     ключ идемпотентности пакета (bundle-key.ts) и путь файла в S3;
--   * recipient_id — операционный получатель: для отгрузки его выбирает
--     человек в карточке, и от него зависит статус «Черновик».
-- Поэтому стороны документа получают собственные поля.
--
-- Почему у каждой стороны ДВА поля. Графа 4 печатной формы содержит название
-- и адрес, но не ИНН («Грузополучатель и его адрес ООО "СУ-10", Россия, …»),
-- а counterparties.inn объявлен NOT NULL — нормализовать такую сторону в
-- контрагента невозможно. *_name_raw хранит распознанный текст всегда, FK
-- заполняется только когда в документе есть ИНН.

ALTER TABLE "source_documents"
  ADD COLUMN IF NOT EXISTS "buyer_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "buyer_name_raw" text,
  ADD COLUMN IF NOT EXISTS "consignee_id" uuid REFERENCES "counterparties"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "consignee_name_raw" text;
--> statement-breakpoint
-- Бэкфилл покупателя из уже распознанного.
--
-- Для inbound-УПД recipient_id заполняет ТОЛЬКО парсер: форма редактирования
-- на приёмке пишет contractor_id и recipient_id не трогает (см. onSave в
-- SourceDocumentDetailModal). Значит там лежит именно покупатель из графы 6, и
-- колонка «Покупатель» не будет пустой на всей истории.
--
-- Для outbound копировать нельзя: там recipient_id — получатель отгрузки,
-- выбранный человеком.
UPDATE "source_documents"
   SET "buyer_id" = "recipient_id"
 WHERE "direction" = 'inbound'
   AND "kind" = 'upd'
   AND "recipient_id" IS NOT NULL
   AND "buyer_id" IS NULL;
