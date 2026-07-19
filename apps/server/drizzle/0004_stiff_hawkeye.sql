CREATE TABLE "environment_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text,
	"allow_ai_observe" boolean DEFAULT true NOT NULL,
	"allow_ai_generate" boolean DEFAULT true NOT NULL,
	"allow_ai_execute" boolean DEFAULT false NOT NULL,
	"allow_auto_submit" boolean DEFAULT false NOT NULL,
	"require_confirmation_before_submit" boolean DEFAULT true NOT NULL,
	"require_confirmation_before_attachment_upload" boolean DEFAULT true NOT NULL,
	"redaction_policy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"default_environment_id" text,
	"default_llm_provider_config_id" text,
	"redaction_policy_id" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_profiles" ADD CONSTRAINT "environment_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_profiles" ADD CONSTRAINT "environment_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_workspace_key" ON "projects" USING btree ("workspace_id","key");