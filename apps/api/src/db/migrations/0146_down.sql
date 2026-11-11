-- Откат 0146: сначала откатить код договоров по документу, потом схему.
-- Договоры документов откат не переживёт — откатывать, только если их нет.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery_contracts WHERE source_document_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Откат 0146 невозможен: у документов приёмок выбраны договоры — сначала отвяжите их';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE delivery_contract_events
  DROP CONSTRAINT IF EXISTS delivery_contract_events_reason_check,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS source_document_id;
--> statement-breakpoint
ALTER TABLE delivery_contracts DROP CONSTRAINT IF EXISTS delivery_contracts_source_fk;
--> statement-breakpoint
ALTER TABLE delivery_contracts DROP CONSTRAINT IF EXISTS delivery_contracts_scope_uq;
--> statement-breakpoint
ALTER TABLE delivery_contracts DROP COLUMN IF EXISTS source_document_id;
--> statement-breakpoint
ALTER TABLE delivery_contracts ADD CONSTRAINT delivery_contracts_pkey PRIMARY KEY (delivery_id);
