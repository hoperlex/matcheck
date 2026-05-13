CREATE TYPE "public"."attachment_role" AS ENUM('original', 'extracted_text');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('expected', 'arrived', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."llm_kind" AS ENUM('openrouter', 'google_ai_studio', 'qwen_self_hosted', 'vertex');--> statement-breakpoint
CREATE TYPE "public"."photo_kind" AS ENUM('document', 'cargo', 'vehicle', 'other');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('upd', 'request');--> statement-breakpoint
CREATE TYPE "public"."source_origin" AS ENUM('edo_diadoc', 'manual_xml', 'manual_pdf', 'mail');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('parsed', 'parse_failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'manager', 'inspector_kpp');--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"email_hash" varchar(64),
	"ip" varchar(64),
	"user_agent" text,
	"event" varchar(64) NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inn" varchar(12) NOT NULL,
	"kpp" varchar(9),
	"name" text NOT NULL,
	"address" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_carrier" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "delivery_status" DEFAULT 'expected' NOT NULL,
	"supplier_id" uuid,
	"vehicle_plate" varchar(16),
	"driver_name" text,
	"arrived_at" timestamp with time zone,
	"inspector_id" uuid,
	"comment" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"material_id" uuid,
	"name_raw" text NOT NULL,
	"qty_planned" numeric(18, 4),
	"qty_actual" numeric(18, 4),
	"unit" varchar(16) DEFAULT 'шт' NOT NULL,
	"comment" text,
	"line_no" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"kind" "photo_kind" DEFAULT 'cargo' NOT NULL,
	"s3_key" text NOT NULL,
	"thumb_s3_key" text,
	"content_hash" varchar(64),
	"idempotency_key" uuid,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_sources" (
	"delivery_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	CONSTRAINT "delivery_sources_delivery_id_source_document_id_pk" PRIMARY KEY("delivery_id","source_document_id")
);
--> statement-breakpoint
CREATE TABLE "edo_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(32) DEFAULT 'diadoc' NOT NULL,
	"name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "llm_kind" NOT NULL,
	"api_base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"temperature" numeric(4, 2) DEFAULT '0.2' NOT NULL,
	"max_tokens" integer DEFAULT 4096 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"use_tls" boolean DEFAULT true NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"last_uid" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64),
	"name" text NOT NULL,
	"unit" varchar(16) DEFAULT 'шт' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"ip" varchar(64),
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_ip" varchar(64),
	"last_seen_ua" text,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_document_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" varchar(128),
	"size_bytes" integer,
	"role" "attachment_role" DEFAULT 'original' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_document_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"material_id" uuid,
	"name_raw" text NOT NULL,
	"qty" numeric(18, 4) NOT NULL,
	"unit" varchar(16) DEFAULT 'шт' NOT NULL,
	"price" numeric(18, 4),
	"sum" numeric(18, 2),
	"vat_rate" numeric(5, 2),
	"vat_sum" numeric(18, 2),
	"expected_date" timestamp,
	"line_no" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "source_kind" NOT NULL,
	"status" "source_status" DEFAULT 'parsed' NOT NULL,
	"supplier_id" uuid,
	"recipient_id" uuid,
	"doc_number" text,
	"doc_date" timestamp,
	"total_sum" numeric(18, 2),
	"vat_sum" numeric(18, 2),
	"expected_date" timestamp,
	"origin" "source_origin" NOT NULL,
	"edo_account_id" uuid,
	"provider_message_id" text,
	"mail_account_id" uuid,
	"message_id" text,
	"message_received_at" timestamp with time zone,
	"llm_provider_id" uuid,
	"llm_confidence" numeric(4, 3),
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_upd_required" CHECK (("source_documents"."kind" <> 'upd') or ("source_documents"."doc_number" is not null and "source_documents"."doc_date" is not null and "source_documents"."total_sum" is not null))
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_in" integer DEFAULT 0 NOT NULL,
	"items_out" integer DEFAULT 0 NOT NULL,
	"error_text" text
);
--> statement-breakpoint
CREATE TABLE "unauthorized_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"status_code" integer NOT NULL,
	"method" varchar(8) NOT NULL,
	"path" text NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"error_message" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'manager' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sessions_invalidated_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_supplier_id_counterparties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_inspector_id_users_id_fk" FOREIGN KEY ("inspector_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_photos" ADD CONSTRAINT "delivery_photos_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sources" ADD CONSTRAINT "delivery_sources_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sources" ADD CONSTRAINT "delivery_sources_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document_attachments" ADD CONSTRAINT "source_document_attachments_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document_items" ADD CONSTRAINT "source_document_items_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document_items" ADD CONSTRAINT "source_document_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_supplier_id_counterparties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_recipient_id_counterparties_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_edo_account_id_edo_accounts_id_fk" FOREIGN KEY ("edo_account_id") REFERENCES "public"."edo_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_mail_account_id_mail_accounts_id_fk" FOREIGN KEY ("mail_account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_llm_provider_id_llm_providers_id_fk" FOREIGN KEY ("llm_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unauthorized_access_log" ADD CONSTRAINT "unauthorized_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_events_user_ts_idx" ON "auth_events" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "auth_events_event_ts_idx" ON "auth_events" USING btree ("event","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_inn_kpp_unique" ON "counterparties" USING btree ("inn","kpp") WHERE "counterparties"."kpp" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "counterparty_inn_unique" ON "counterparties" USING btree ("inn") WHERE "counterparties"."kpp" is null;--> statement-breakpoint
CREATE INDEX "counterparty_supplier_idx" ON "counterparties" USING btree ("name") WHERE "counterparties"."is_supplier";--> statement-breakpoint
CREATE INDEX "counterparty_carrier_idx" ON "counterparties" USING btree ("name") WHERE "counterparties"."is_carrier";--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_photo_content_unique" ON "delivery_photos" USING btree ("delivery_id","content_hash") WHERE "delivery_photos"."content_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_photo_idempotency_unique" ON "delivery_photos" USING btree ("delivery_id","idempotency_key") WHERE "delivery_photos"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "material_code_unique" ON "materials" USING btree ("code") WHERE "materials"."code" is not null;--> statement-breakpoint
CREATE INDEX "material_name_idx" ON "materials" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_token_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "source_edo_message_unique" ON "source_documents" USING btree ("edo_account_id","provider_message_id") WHERE "source_documents"."edo_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_mail_message_unique" ON "source_documents" USING btree ("mail_account_id","message_id") WHERE "source_documents"."mail_account_id" is not null;--> statement-breakpoint
CREATE INDEX "source_kind_doc_date_idx" ON "source_documents" USING btree ("doc_date") WHERE "source_documents"."kind" = 'upd';--> statement-breakpoint
CREATE INDEX "source_kind_expected_date_idx" ON "source_documents" USING btree ("expected_date") WHERE "source_documents"."kind" = 'request';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));