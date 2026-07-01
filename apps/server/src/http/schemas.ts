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

export type AnalyzeBody = z.infer<typeof analyzeSchema>;
export type TestCasesBody = z.infer<typeof testCasesSchema>;
export type BugReportBody = z.infer<typeof bugReportSchema>;
export type PlaywrightBody = z.infer<typeof playwrightSchema>;
export type ChatBody = z.infer<typeof chatSchema>;
