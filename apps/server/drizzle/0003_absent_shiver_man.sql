CREATE TABLE "ai_task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"environment_id" text,
	"session_id" text,
	"user_id" text NOT NULL,
	"task_type" text NOT NULL,
	"llm_provider_config_id" text,
	"model_name" text,
	"status" text NOT NULL,
	"input_token_count" integer,
	"output_token_count" integer,
	"estimated_cost_usd" double precision,
	"duration_ms" integer,
	"error_code" text,
	"error_message_safe" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"llm_provider_config_id" text,
	"task_type" text NOT NULL,
	"model_name" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;