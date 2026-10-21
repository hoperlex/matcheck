-- Откат 0135: признак «Материалы подрядчика» у приёмок сбрасывается в NULL,
-- иначе старый CHECK не встанет. Сначала откатить код, потом схему.
UPDATE deliveries SET purpose = NULL WHERE purpose = 'contractor_materials';
--> statement-breakpoint
ALTER TABLE deliveries
  DROP CONSTRAINT deliveries_purpose_chk,
  ADD CONSTRAINT deliveries_purpose_chk
  CHECK (purpose IN ('own_forces', 'realization', 'tolling_act'));
