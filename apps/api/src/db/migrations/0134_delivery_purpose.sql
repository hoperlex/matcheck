ALTER TABLE deliveries
  ADD COLUMN purpose VARCHAR(24)
  CONSTRAINT deliveries_purpose_chk
  CHECK (purpose IN ('own_forces', 'realization', 'tolling_act'));
