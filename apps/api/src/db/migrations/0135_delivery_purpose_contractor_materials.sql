ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_purpose_chk,
  ADD CONSTRAINT deliveries_purpose_chk
  CHECK (purpose IN ('own_forces', 'realization', 'tolling_act', 'contractor_materials'));
