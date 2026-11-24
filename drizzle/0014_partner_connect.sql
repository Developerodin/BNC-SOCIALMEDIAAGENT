CREATE TABLE "partner_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "partner_connect_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"shop_domain" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"approved_by_user_id" text,
	"decided_at" timestamp with time zone,
	"exchanged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_connect_requests_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "partner_connect_requests_status_chk" CHECK ("partner_connect_requests"."status" in ('pending', 'approved', 'denied', 'exchanged', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "partner_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"shop_domain" text NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"connect_request_id" uuid,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "partner_grants_connect_request_id_unique" UNIQUE("connect_request_id"),
	CONSTRAINT "partner_grants_store_id_id_uq" UNIQUE("store_id","id"),
	CONSTRAINT "partner_grants_revoked_reason_chk" CHECK ("partner_grants"."revoked_reason" in ('portal', 'app_uninstalled', 'code_replay', 'refresh_replay', 'reconnect', 'merchant'))
);
--> statement-breakpoint
CREATE TABLE "partner_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "partner_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "partner_tokens_kind_chk" CHECK ("partner_tokens"."kind" in ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "partner_connect_requests" ADD CONSTRAINT "partner_connect_requests_client_id_partner_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."partner_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_grants" ADD CONSTRAINT "partner_grants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_grants" ADD CONSTRAINT "partner_grants_client_id_partner_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."partner_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_grants" ADD CONSTRAINT "partner_grants_connect_request_fk" FOREIGN KEY ("connect_request_id") REFERENCES "public"."partner_connect_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_tokens" ADD CONSTRAINT "partner_tokens_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_tokens" ADD CONSTRAINT "partner_tokens_grant_fk" FOREIGN KEY ("store_id","grant_id") REFERENCES "public"."partner_grants"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_connect_requests_shop_domain_idx" ON "partner_connect_requests" USING btree ("shop_domain");--> statement-breakpoint
CREATE INDEX "partner_connect_requests_expires_at_idx" ON "partner_connect_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_grants_active_store_client_uq" ON "partner_grants" USING btree ("store_id","client_id") WHERE "partner_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "partner_tokens_grant_id_idx" ON "partner_tokens" USING btree ("grant_id");