import { z } from 'zod';

const pageModelSchema = z
  .object({
    summary: z.object({ url: z.string() }).passthrough(),
    elements: z.array(z.any()),
    capturedAt: z.string(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    events: z.array(z.any()),
  })
  .passthrough();

export const analyzeSchema = z.object({
  pageModel: pageModelSchema,
  question: z.string().optional(),
  environment: z.string().optional(),
});

export const testCasesSchema = z.object({
  pageModel: pageModelSchema,
  format: z.string().optional(),
  focus: z.string().optional(),
});

export const bugReportSchema = z.object({
  session: sessionSchema,
  pageModel: pageModelSchema.nullable().optional(),
  userNote: z.string().default(''),
  includeConsoleErrors: z.boolean().optional(),
  includeNetworkFailures: z.boolean().optional(),
});

export const playwrightSchema = z.object({
  session: sessionSchema,
  enrich: z.boolean().optional(),
});

export type AnalyzeBody = z.infer<typeof analyzeSchema>;
export type TestCasesBody = z.infer<typeof testCasesSchema>;
export type BugReportBody = z.infer<typeof bugReportSchema>;
export type PlaywrightBody = z.infer<typeof playwrightSchema>;

// --- Multi-user platform schemas ---

const WORKSPACE_ROLE = z.enum(['owner', 'admin', 'qa_lead', 'tester', 'viewer']);

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: WORKSPACE_ROLE.default('tester'),
});

export const createLlmProviderSchema = z.object({
  scope: z.enum(['workspace', 'project', 'user']).default('workspace'),
  providerType: z.literal('openai_compatible').default('openai_compatible'),
  displayName: z.string().trim().min(1),
  baseUrl: z.string().url(),
  modelName: z.string().trim().min(1),
  apiKey: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

export const updateLlmProviderSchema = z
  .object({
    displayName: z.string().trim().min(1),
    baseUrl: z.string().url(),
    modelName: z.string().trim().min(1),
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
    timeoutSeconds: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .partial();

export const rotateProviderSecretSchema = z.object({
  apiKey: z.string().min(1),
});

export const aiGenerateBugReportSchema = z.object({
  session: sessionSchema,
  pageModel: pageModelSchema.nullable().optional(),
  userNote: z.string().default(''),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
});

// --- Projects & environments (Milestone 2) ---

const ENV_NAME = z.enum(['local', 'dev', 'staging', 'uat', 'production', 'custom']);

export const createProjectSchema = z.object({
  name: z.string().trim().min(1),
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'key may only contain letters, digits, _ or -'),
  description: z.string().trim().optional(),
  defaultLlmProviderConfigId: z.string().optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim(),
    defaultEnvironmentId: z.string(),
    defaultLlmProviderConfigId: z.string().nullable(),
    redactionPolicyId: z.string().nullable(),
  })
  .partial();

export const createEnvironmentSchema = z.object({
  name: ENV_NAME,
  displayName: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().optional(),
  allowAiObserve: z.boolean().optional(),
  allowAiGenerate: z.boolean().optional(),
  allowAiExecute: z.boolean().optional(),
  allowAutoSubmit: z.boolean().optional(),
  requireConfirmationBeforeSubmit: z.boolean().optional(),
  requireConfirmationBeforeAttachmentUpload: z.boolean().optional(),
});

export const resolveUrlQuerySchema = z.object({ url: z.string().url() });
