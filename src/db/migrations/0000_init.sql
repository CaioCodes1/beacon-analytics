CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_event_rollup" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"event_name" text NOT NULL,
	"country" char(2) DEFAULT '??' NOT NULL,
	"device" text DEFAULT 'unknown' NOT NULL,
	"event_count" bigint NOT NULL,
	"unique_visitors" bigint NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_event_rollup_project_id_day_event_name_country_device_pk" PRIMARY KEY("project_id","day","event_name","country","device")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymous_id" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"path" text,
	"referrer" text,
	"country" char(2),
	"device" text,
	"browser" text,
	"os" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_event_rollup" ADD CONSTRAINT "daily_event_rollup_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_unique" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "rollup_project_day_idx" ON "daily_event_rollup" USING btree ("project_id","day");--> statement-breakpoint
CREATE INDEX "events_project_time_idx" ON "events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_project_name_time_idx" ON "events" USING btree ("project_id","name","occurred_at");--> statement-breakpoint
CREATE INDEX "events_project_anon_time_idx" ON "events" USING btree ("project_id","anonymous_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_project_user_idx" ON "events" USING btree ("project_id","user_id") WHERE "events"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_unique" ON "events" USING btree ("project_id","idempotency_key") WHERE "events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");