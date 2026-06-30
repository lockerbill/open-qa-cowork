/**
 * Drizzle schema — single source of truth for the multi-tenant tables.
 *
 * Tables are added per implementation stage:
 *   Stage 1 — users, externalIdentities, workspaces, workspaceMembers, auditLogs
 *   Stage 2 — secrets
 *   Stage 3 — llmProviderConfigs (+ workspaces.defaultLlmProviderConfigId)
 *   Stage 4 — aiTaskRuns, usageLogs
 *   Stage 5 — projects, environmentProfiles
 *
 * Run `pnpm --filter @qa-copilot/server db:generate` after editing to emit a
 * migration into ./drizzle, then `db:migrate` to apply it to Postgres.
 */
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Stage 1 — a person who can sign in. */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  displayName: text('display_name'),
  status: text('status').notNull().default('active'), // active | disabled
  createdAt,
  updatedAt,
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

/**
 * Stage 1 — a login method for a user. Supports future providers (google,
 * github, ...) without touching `users`. For `provider = 'password'` the bcrypt
 * hash lives in `passwordHash`.
 */
export const externalIdentities = pgTable('external_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  provider: text('provider').notNull(), // password | google | github | ...
  providerUserId: text('provider_user_id'),
  email: text('email'),
  passwordHash: text('password_hash'),
  createdAt,
  updatedAt,
});

/** Stage 1 — a team/company/personal account that owns projects, providers, secrets. */
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  plan: text('plan').notNull().default('free'),
  createdByUserId: text('created_by_user_id')
    .notNull()
    .references(() => users.id),
  /** Stage 3 — workspace's default LLM provider config (set after a config exists). */
  defaultLlmProviderConfigId: text('default_llm_provider_config_id'),
  createdAt,
  updatedAt,
});

/** Stage 1 — a user's membership + role in a workspace. */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(), // owner | admin | qa_lead | tester | viewer
    status: text('status').notNull().default('active'), // invited | active | disabled
    invitedByUserId: text('invited_by_user_id'),
    createdAt,
    updatedAt,
  },
  (t) => ({
    uniqMember: uniqueIndex('uniq_workspace_user').on(t.workspaceId, t.userId),
  }),
);

/**
 * Stage 2 — encrypted secret vault. `encryptedValue` holds AES-256-GCM
 * ciphertext (iv|tag|ct, base64); the plaintext is never stored, returned by an
 * API, or logged.
 */
export const secrets = pgTable('secrets', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  ownerUserId: text('owner_user_id'),
  name: text('name').notNull(),
  type: text('type').notNull(), // llm_api_key | jira_refresh_token | generic_api_key
  encryptedValue: text('encrypted_value').notNull(),
  encryptionKeyVersion: integer('encryption_key_version').notNull().default(1),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt,
  updatedAt,
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/**
 * Stage 3 — a BYO LLM provider configuration. The API key itself lives in the
 * secret vault (`secretId`); this row only holds non-sensitive connection
 * settings. Only `openai_compatible` is supported in this milestone.
 */
export const llmProviderConfigs = pgTable('llm_provider_configs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  ownerUserId: text('owner_user_id'),
  scope: text('scope').notNull().default('workspace'), // workspace | project | user
  providerType: text('provider_type').notNull().default('openai_compatible'),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  modelName: text('model_name').notNull(),
  secretId: text('secret_id')
    .notNull()
    .references(() => secrets.id),
  enabled: boolean('enabled').notNull().default(true),
  maxOutputTokens: integer('max_output_tokens').notNull().default(2048),
  temperature: doublePrecision('temperature').notNull().default(0.2),
  timeoutSeconds: integer('timeout_seconds').notNull().default(60),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt,
  updatedAt,
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  validationStatus: text('validation_status').notNull().default('unknown'), // unknown | valid | invalid
  validationError: text('validation_error'),
});

/**
 * Stage 5 — a product/app under test inside a workspace. `key` is a short
 * human label (e.g. ERP) unique within the workspace. `defaultEnvironmentId` is
 * a soft pointer to an environmentProfiles row (no hard FK — avoids a circular
 * dependency with environment_profiles.project_id); it is validated in the
 * service when set. `redactionPolicyId` is a nullable passthrough — there is no
 * RedactionPolicy table this milestone.
 */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    key: text('key').notNull(),
    description: text('description'),
    defaultEnvironmentId: text('default_environment_id'),
    defaultLlmProviderConfigId: text('default_llm_provider_config_id'),
    redactionPolicyId: text('redaction_policy_id'),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt,
    updatedAt,
  },
  (t) => ({
    uniqKey: uniqueIndex('uniq_project_workspace_key').on(t.workspaceId, t.key),
  }),
);

/**
 * Stage 5 — a named environment for a project (local/dev/staging/uat/production
 * /custom). `baseUrl` (nullable) is matched against a tab URL to detect the
 * active environment. The boolean flags gate what the AI is allowed to do per
 * environment; safe defaults are seeded by name (see modules/projects/env-defaults).
 */
export const environmentProfiles = pgTable('environment_profiles', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  name: text('name').notNull(), // local | dev | staging | uat | production | custom
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url'),
  allowAiObserve: boolean('allow_ai_observe').notNull().default(true),
  allowAiGenerate: boolean('allow_ai_generate').notNull().default(true),
  allowAiExecute: boolean('allow_ai_execute').notNull().default(false),
  allowAutoSubmit: boolean('allow_auto_submit').notNull().default(false),
  requireConfirmationBeforeSubmit: boolean('require_confirmation_before_submit')
    .notNull()
    .default(true),
  requireConfirmationBeforeAttachmentUpload: boolean(
    'require_confirmation_before_attachment_upload',
  )
    .notNull()
    .default(true),
  redactionPolicyId: text('redaction_policy_id'),
  createdAt,
  updatedAt,
});

/** Stage 4 — one row per AI task execution. Never stores unredacted prompt content. */
export const aiTaskRuns = pgTable('ai_task_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  projectId: text('project_id'),
  environmentId: text('environment_id'),
  sessionId: text('session_id'),
  userId: text('user_id').notNull(),
  taskType: text('task_type').notNull(),
  llmProviderConfigId: text('llm_provider_config_id'),
  modelName: text('model_name'),
  status: text('status').notNull(), // queued | running | succeeded | failed | cancelled
  inputTokenCount: integer('input_token_count'),
  outputTokenCount: integer('output_token_count'),
  estimatedCostUsd: doublePrecision('estimated_cost_usd'),
  durationMs: integer('duration_ms'),
  errorCode: text('error_code'),
  errorMessageSafe: text('error_message_safe'),
  createdAt,
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/** Stage 4 — append-only usage record (for future billing/analytics). */
export const usageLogs = pgTable('usage_logs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(),
  projectId: text('project_id'),
  llmProviderConfigId: text('llm_provider_config_id'),
  taskType: text('task_type').notNull(),
  modelName: text('model_name'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCostUsd: doublePrecision('estimated_cost_usd'),
  createdAt,
});

/** Stage 1 — append-only audit trail of security-relevant actions. */
export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  metadata: jsonb('metadata'),
  createdAt,
});
