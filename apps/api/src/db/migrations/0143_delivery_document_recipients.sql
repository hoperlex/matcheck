ALTER TABLE deliveries
  ADD COLUMN recipients_per_document boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE delivery_sources
  ADD COLUMN own_recipient boolean NOT NULL DEFAULT false,
  ADD COLUMN contractor_id uuid REFERENCES counterparties(id) ON DELETE SET NULL,
  ADD COLUMN recipient_mol_id uuid REFERENCES responsible_persons(id) ON DELETE SET NULL,
  ADD COLUMN own_purpose boolean NOT NULL DEFAULT false,
  ADD COLUMN purpose varchar(24),
  ADD CONSTRAINT delivery_sources_own_recipient_chk CHECK (own_recipient OR (contractor_id IS NULL AND recipient_mol_id IS NULL)),
  ADD CONSTRAINT delivery_sources_own_purpose_chk CHECK (own_purpose OR purpose IS NULL),
  ADD CONSTRAINT delivery_sources_recipient_chk CHECK (NOT (contractor_id IS NOT NULL AND recipient_mol_id IS NOT NULL)),
  ADD CONSTRAINT delivery_sources_purpose_chk CHECK (purpose IN ('own_forces', 'realization', 'tolling_act', 'contractor_materials', 'realization_tolling')),
  ADD CONSTRAINT delivery_sources_contractor_purpose_chk CHECK (NOT (own_recipient AND contractor_id IS NOT NULL AND own_purpose AND purpose = 'own_forces'));
