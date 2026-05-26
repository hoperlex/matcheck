-- Финансовый снимок позиции из УПД на момент создания приёмки/отгрузки.
-- price/vat_rate подтягиваются из source_document_items при первой
-- инициализации; vat_sum пересчитывается клиентом из qtyActual×price×vat_rate
-- и сохраняется обратно при «Сохранить». Все три поля nullable —
-- у позиций, добавленных инспектором вручную, цены может не быть.
ALTER TABLE "delivery_items"
  ADD COLUMN IF NOT EXISTS "price" numeric(18, 4),
  ADD COLUMN IF NOT EXISTS "vat_rate" numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "vat_sum" numeric(18, 2);

ALTER TABLE "shipment_items"
  ADD COLUMN IF NOT EXISTS "price" numeric(18, 4),
  ADD COLUMN IF NOT EXISTS "vat_rate" numeric(5, 2),
  ADD COLUMN IF NOT EXISTS "vat_sum" numeric(18, 2);
