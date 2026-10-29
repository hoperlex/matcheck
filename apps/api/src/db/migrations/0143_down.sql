ALTER TABLE delivery_sources
  DROP COLUMN own_recipient,
  DROP COLUMN contractor_id,
  DROP COLUMN recipient_mol_id,
  DROP COLUMN own_purpose,
  DROP COLUMN purpose;
--> statement-breakpoint
ALTER TABLE deliveries DROP COLUMN recipients_per_document;
