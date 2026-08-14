import { z } from 'zod';
import { zStepRequest } from '@qa-copilot/shared/auto';

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

/** Auto Test Mode defect prefill (auto-test-mode-spec §11). */
const defectPrefillSchema = z.object({
  summary: z.string().max(300),
  expected: z.string().max(300),
  actual: z.string().max(300),
  traceExcerpt: z.string().max(4000),
});

export const bugReportSchema = z.object({
  session: sessionSchema,
  pageModel: pageModelSchema.nullable().optional(),
  userNote: z.string().default(''),
  includeConsoleErrors: z.boolean().optional(),
  includeNetworkFailures: z.boolean().optional(),
  defect: defectPrefillSchema.optional(),
});

export const playwrightSchema = z.object({
  session: sessionSchema,
  enrich: z.boolean().optional(),
});

export const chatSchema = z.object({
  // Client sends only user/assistant turns; the server prepends its own system
  // message. Bounds keep the payload (and token cost) sane.
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  maxTokens: z.number().int().positive().max(8192).optional(),
});

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
  defect: defectPrefillSchema.optional(),
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

// --- Authed gateway equivalents of the legacy /api/generate/* tasks ---

const aiTaskContextFields = {
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  sessionId: z.string().optional(),
};

export const aiAnalyzePageSchema = z.object({
  pageModel: pageModelSchema,
  question: z.string().optional(),
  ...aiTaskContextFields,
});

export const aiGenerateTestCasesSchema = z.object({
  pageModel: pageModelSchema,
  focus: z.string().optional(),
  ...aiTaskContextFields,
});

export const aiEnrichPlaywrightSchema = z.object({
  session: sessionSchema,
  enrich: z.boolean().optional(),
  ...aiTaskContextFields,
});

// Same message/token bounds as the legacy chat route, plus task context.
export const aiChatSchema = z.object({
  ...chatSchema.shape,
  ...aiTaskContextFields,
});

/**
 * POST /auto/step body: the shared StepRequest contract plus the layered
 * provider-resolution context the other gateway tasks carry (project default →
 * workspace default).
 */
export const autoStepSchema = zStepRequest.extend({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
});
