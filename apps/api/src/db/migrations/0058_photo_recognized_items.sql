-- Кэш распознавания позиций из фото-документа (ТТН-2116/ОС-2) для
-- split-view модалки в портале (раздел Принятые → клик на фото с
-- kind='document'). Без этого кэша каждый повторный клик прогоняет
-- одно и то же фото через LLM, что дорого и медленно.
--
-- Полиморфизм: фото живёт либо в delivery_photos, либо в shipment_photos,
-- поэтому два опциональных FK + partial unique индексы на каждом.
-- CHECK гарантирует, что ровно один FK заполнен.
-- ON DELETE CASCADE — при удалении фото запись чистится.

CREATE TABLE IF NOT EXISTS "photo_recognized_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_photo_id" uuid REFERENCES "delivery_photos"("id") ON DELETE CASCADE,
  "shipment_photo_id" uuid REFERENCES "shipment_photos"("id") ON DELETE CASCADE,
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Метаданные документа из LLM: форма (tn_2116/os2), номер, дата,
  -- итог, общая уверенность. Используются справа в шапке таблицы.
  "doc_form" varchar(32),
  "doc_number" text,
  "doc_date" date,
  "total_sum" numeric(20, 2),
  "confidence" numeric(3, 2),
  "model" text,
  -- error_message не NULL значит распознавание упало; items в этом случае
  -- пуст. Фронт показывает сообщение и кнопку «Повторить».
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "photo_recognized_one_photo_chk" CHECK (
    (("delivery_photo_id" IS NOT NULL)::int + ("shipment_photo_id" IS NOT NULL)::int) = 1
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "photo_recognized_delivery_uidx"
  ON "photo_recognized_items"("delivery_photo_id")
  WHERE "delivery_photo_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "photo_recognized_shipment_uidx"
  ON "photo_recognized_items"("shipment_photo_id")
  WHERE "shipment_photo_id" IS NOT NULL;
