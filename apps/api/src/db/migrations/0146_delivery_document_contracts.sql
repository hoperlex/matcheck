-- Договор 1С по документу приёмки (режим «Разные получатели по документам»).
--
-- delivery_contracts: была одна строка на приёмку (PK delivery_id). Теперь —
-- общая строка (source_document_id IS NULL) плюс по одной на документ.
-- Уникальность (delivery_id, source_document_id) с NULLS NOT DISTINCT: общая
-- запись у приёмки одна, как и раньше (PG ≥ 15).
--
-- Составной FK на delivery_sources (delivery_id, source_document_id) с CASCADE —
-- страховка: отвязка документа (unlink-source) снимает его договор явно, с
-- записью в журнал, а каскад не даст строке пережить связь. У общей записи
-- source_document_id IS NULL, MATCH SIMPLE её не проверяет.
--
-- delivery_contract_events: source_document_id (NULL — общий договор) и reason —
-- почему договор снят без действия человека: mode_off (выключили «разные
-- получатели») или document_unlinked (документ отвязали от приёмки).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE delivery_contracts ADD COLUMN source_document_id uuid;
--> statement-breakpoint
ALTER TABLE delivery_contracts DROP CONSTRAINT delivery_contracts_pkey;
--> statement-breakpoint
ALTER TABLE delivery_contracts
  ADD CONSTRAINT delivery_contracts_scope_uq UNIQUE NULLS NOT DISTINCT (delivery_id, source_document_id);
--> statement-breakpoint
ALTER TABLE delivery_contracts
  ADD CONSTRAINT delivery_contracts_source_fk FOREIGN KEY (delivery_id, source_document_id)
  REFERENCES delivery_sources (delivery_id, source_document_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE delivery_contract_events
  ADD COLUMN source_document_id uuid,
  ADD COLUMN reason text,
  ADD CONSTRAINT delivery_contract_events_reason_check
    CHECK (reason IS NULL OR reason IN ('mode_off', 'document_unlinked'));
