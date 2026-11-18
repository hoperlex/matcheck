-- Откат 0152: сначала откатить портал и API (старый код новых колонок не
-- видит, отменять миграцию для отката кода не нужно). Отмена стирает
-- получателей, признаки и договоры, выбранные для УПД из ЭДО без скана.
ALTER TABLE delivery_contract_events DROP COLUMN IF EXISTS edo_match_id;
--> statement-breakpoint
DROP INDEX IF EXISTS delivery_edo_matches_contract_idx;
--> statement-breakpoint
ALTER TABLE delivery_edo_matches
  DROP COLUMN IF EXISTS own_recipient,
  DROP COLUMN IF EXISTS contractor_id,
  DROP COLUMN IF EXISTS recipient_mol_id,
  DROP COLUMN IF EXISTS own_purpose,
  DROP COLUMN IF EXISTS purpose,
  DROP COLUMN IF EXISTS contract_id,
  DROP COLUMN IF EXISTS contract_linked_by_user_id,
  DROP COLUMN IF EXISTS contract_linked_at;
