CREATE TABLE "llm_provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"provider_type" text DEFAULT 'openai_compatible' NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"model_name" text NOT NULL,
	"secret_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_output_tokens" integer DEFAULT 2048 NOT NULL,
	"temperature" double precision DEFAULT 0.2 NOT NULL,
	"timeout_seconds" integer DEFAULT 60 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_validated_at" timestamp with time zone,
	"validation_status" text DEFAULT 'unknown' NOT NULL,
	"validation_error" text
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_llm_provider_config_id" text;--> statement-breakpoint
ALTER TABLE "llm_provider_configs" ADD CONSTRAINT "llm_provider_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_provider_configs" ADD CONSTRAINT "llm_provider_configs_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;