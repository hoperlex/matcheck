CREATE TABLE "statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(128) NOT NULL,
	"color" varchar(32),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_entity_code_unique" ON "statuses" ("entity_type","code");
--> statement-breakpoint
INSERT INTO "statuses" ("entity_type","code","label","color","sort_order") VALUES
  ('delivery','not_filled','Не оформлена','orange',10),
  ('delivery','draft','Черновик','default',20),
  ('delivery','filled','Оформлена','green',30);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "status_id" uuid REFERENCES "statuses"("id");
--> statement-breakpoint
UPDATE "deliveries" SET "status_id" = (
  SELECT "id" FROM "statuses"
  WHERE "entity_type" = 'delivery' AND "code" =
    CASE
      WHEN "deliveries"."status" = 'draft' THEN 'draft'
      WHEN "deliveries"."status" = 'verified' THEN 'filled'
      ELSE 'not_filled'
    END
);
--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "status_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "status";
--> statement-breakpoint
DROP TYPE "public"."delivery_status";
