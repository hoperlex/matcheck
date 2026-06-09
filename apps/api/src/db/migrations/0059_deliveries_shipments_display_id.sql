-- Короткий человекочитаемый id для приёмок и отгрузок (показывается в
-- разделе Принятые столбцом «id» после «№» и в заголовке модалок:
-- «Приёмка #N» / «Отгрузка #N»). Отдельные счётчики для каждой
-- сущности — id у приёмки и отгрузки могут совпадать, это нормально
-- (разная нумерация).
--
-- Стратегия миграции (одинаковая для deliveries и shipments):
--   1) ALTER ADD COLUMN BIGINT (nullable временно — чтобы backfill прошёл).
--   2) Backfill по createdAt ASC через ROW_NUMBER → стабильные значения
--      для уже существующих записей.
--   3) Создать SEQUENCE, выставить start_value = max(display_id) + 1.
--   4) SET DEFAULT nextval(seq) + SET NOT NULL + UNIQUE INDEX.
--   5) ALTER SEQUENCE … OWNED BY — удаляется при drop column.

-- ── deliveries ─────────────────────────────────────────────────────────────

ALTER TABLE deliveries ADD COLUMN display_id BIGINT;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM deliveries
)
UPDATE deliveries d
   SET display_id = o.rn
  FROM ordered o
 WHERE d.id = o.id;

CREATE SEQUENCE IF NOT EXISTS deliveries_display_id_seq;
SELECT setval(
  'deliveries_display_id_seq',
  COALESCE((SELECT MAX(display_id) FROM deliveries), 0) + 1,
  false
);

ALTER TABLE deliveries
  ALTER COLUMN display_id SET DEFAULT nextval('deliveries_display_id_seq');
ALTER TABLE deliveries
  ALTER COLUMN display_id SET NOT NULL;
ALTER SEQUENCE deliveries_display_id_seq OWNED BY deliveries.display_id;
CREATE UNIQUE INDEX deliveries_display_id_uidx ON deliveries(display_id);

-- ── shipments ─────────────────────────────────────────────────────────────

ALTER TABLE shipments ADD COLUMN display_id BIGINT;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM shipments
)
UPDATE shipments s
   SET display_id = o.rn
  FROM ordered o
 WHERE s.id = o.id;

CREATE SEQUENCE IF NOT EXISTS shipments_display_id_seq;
SELECT setval(
  'shipments_display_id_seq',
  COALESCE((SELECT MAX(display_id) FROM shipments), 0) + 1,
  false
);

ALTER TABLE shipments
  ALTER COLUMN display_id SET DEFAULT nextval('shipments_display_id_seq');
ALTER TABLE shipments
  ALTER COLUMN display_id SET NOT NULL;
ALTER SEQUENCE shipments_display_id_seq OWNED BY shipments.display_id;
CREATE UNIQUE INDEX shipments_display_id_uidx ON shipments(display_id);
