-- Режим «Разные получатели по документам» для УПД из ЭДО без скана.
--
-- Документ приёмки в этом режиме — загруженный документ (delivery_sources)
-- или свободная УПД из ЭДО (связь без блока, section_document_id IS NULL).
-- Получатель, признак и договор свободной УПД — на её строке связи: так
-- договор не может принадлежать чужой приёмке, а delivery_contracts и её
-- уникальность не меняются. Старый API, который работает между этой миграцией
-- и рестартом, новых колонок не видит, и сохранение договоров у него не
-- ломается: все изменения аддитивные, значения по умолчанию false/NULL.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE delivery_edo_matches
  ADD COLUMN own_recipient boolean NOT NULL DEFAULT false,
  ADD COLUMN contractor_id uuid REFERENCES counterparties(id) ON DELETE SET NULL,
  ADD COLUMN recipient_mol_id uuid REFERENCES responsible_persons(id) ON DELETE SET NULL,
  ADD COLUMN own_purpose boolean NOT NULL DEFAULT false,
  ADD COLUMN purpose varchar(24),
  ADD COLUMN contract_id uuid REFERENCES supplier_contracts(id) ON DELETE RESTRICT,
  ADD COLUMN contract_linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN contract_linked_at timestamptz,
  ADD CONSTRAINT delivery_edo_matches_own_recipient_chk CHECK (own_recipient OR (contractor_id IS NULL AND recipient_mol_id IS NULL)),
  ADD CONSTRAINT delivery_edo_matches_own_purpose_chk CHECK (own_purpose OR purpose IS NULL),
  ADD CONSTRAINT delivery_edo_matches_recipient_chk CHECK (NOT (contractor_id IS NOT NULL AND recipient_mol_id IS NOT NULL)),
  ADD CONSTRAINT delivery_edo_matches_purpose_chk CHECK (purpose IN ('own_forces', 'realization', 'tolling_act', 'contractor_materials', 'realization_tolling')),
  ADD CONSTRAINT delivery_edo_matches_contractor_purpose_chk CHECK (NOT (own_recipient AND contractor_id IS NOT NULL AND own_purpose AND purpose = 'own_forces')),
  ADD CONSTRAINT delivery_edo_matches_contract_linked_chk CHECK ((contract_id IS NULL) = (contract_linked_at IS NULL)),
  -- УПД в блоке скана живёт настройками блока. Блок задаётся только при
  -- создании связи, а unlink-source его лишь обнуляет — переход «свободная →
  -- в блоке» не существует, и CHECK не встанет ни на одном пути записи.
  ADD CONSTRAINT delivery_edo_matches_section_own_chk CHECK (section_document_id IS NULL OR NOT (own_recipient OR own_purpose OR contract_id IS NOT NULL));
--> statement-breakpoint
-- Импорт каталога договоров ищет приёмки по договору.
CREATE INDEX IF NOT EXISTS delivery_edo_matches_contract_idx
  ON delivery_edo_matches (contract_id) WHERE contract_id IS NOT NULL;
--> statement-breakpoint
-- Журнал договоров: договор УПД из ЭДО (без FK, как source_document_id).
ALTER TABLE delivery_contract_events ADD COLUMN edo_match_id uuid;
