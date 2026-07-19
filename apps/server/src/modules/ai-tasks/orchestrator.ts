import { eq } from 'drizzle-orm';
import type { PageModel, TestSession } from '@qa-copilot/shared';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { aiTaskRuns, usageLogs } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import { artifactId, parseJsonLoose, stripFences } from '../../http/util.js';
import type { Logger } from '../../logging/logger.js';
import { LLMError, type LLMProvider } from '../../llm/types.js';
import { LoggingProvider } from '../../llm/logging-provider.js';
import {
  openAICompatibleChatWithUsage,
  openAICompatibleCompleteWithUsage,
  type CompletionUsage,
} from '../../llm/openai-compatible.js';
import {
  analyzeSystem,
  analyzeUser,
  bugReportSystem,
  bugReportUser,
  playwrightEnrichSystem,
  playwrightEnrichUser,
  testCasesSystem,
  testCasesUser,
} from '../../prompts/index.js';
import { readSecretForUse } from '../secrets/service.js';
import { assertSafeProviderUrl } from '../providers/ssrf.js';
import { resolveProviderConfig } from './resolver.js';

export interface AiTaskDeps {
  db: Database;
  masterKey: string;
  logger: Logger;
  allowPrivateHosts: boolean;
}

export interface AiTaskContext {
  workspaceId: string;
  userId: string;
  projectId?: string;
  environmentId?: string;
  sessionId?: string;
}

/**
 * Describes one kind of AI task: how to build its prompt and shape its result.
 * The lifecycle around it (resolve provider, redact, record run/usage/audit) is
 * shared by `runAiTask`.
 */
export interface AiTaskSpec<I, R> {
  taskType: string;
  build: (input: I) => { system: string; user: string; maxTokens?: number };
  shape: (rawText: string) => R;
}

export interface AiTaskResult<R> {
  taskRunId: string;
  result: R;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Build an LLM provider for a resolved config, traced by LoggingProvider. Token
 * usage from the provider response is written into `usageSink` on each call so
 * the caller can record it.
 */
function providerFor(
  config: { baseUrl: string; modelName: string; displayName: string; timeoutSeconds: number },
  apiKey: string,
  logger: Logger,
  usageSink: CompletionUsage,
): LLMProvider {
  const params = {
    baseUrl: config.baseUrl,
    apiKey,
    model: config.modelName,
    label: config.displayName,
    requireApiKey: true,
    timeoutMs: config.timeoutSeconds * 1000,
    redirect: 'error' as const,
  };

  /** Record the provider's reported usage so the caller can persist it. */
  const track = ({ text, usage }: { text: string; usage: CompletionUsage }): string => {
    usageSink.inputTokens = usage.inputTokens;
    usageSink.outputTokens = usage.outputTokens;
    return text;
  };

  const inner: LLMProvider = {
    name: 'openai_compatible',
    complete: async (opts) => track(await openAICompatibleCompleteWithUsage(params, opts)),
    chat: async (opts) => track(await openAICompatibleChatWithUsage(params, opts)),
  };
  return new LoggingProvider(inner, logger, config.modelName);
}

/**
 * Run any AI task through the gateway: resolve the (layered) provider, decrypt
 * its key, redact + build the prompt, call the provider, and record an
 * AiTaskRun + UsageLog + audit events. Records a failed run (with a correlation
 * id) before surfacing a safe error.
 */
export async function runAiTask<I, R>(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  spec: AiTaskSpec<I, R>,
  input: I,
): Promise<AiTaskResult<R>> {
  const { db, masterKey, logger } = deps;
  const config = await resolveProviderConfig(db, ctx.workspaceId, ctx.projectId);
  // Re-check the stored base URL before any server-side request (SSRF guard).
  await assertSafeProviderUrl(config.baseUrl, { allowPrivate: deps.allowPrivateHosts });

  const [run] = await db
    .insert(aiTaskRuns)
    .values({
      id: genId('taskrun'),
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId ?? null,
      environmentId: ctx.environmentId ?? null,
      sessionId: ctx.sessionId ?? null,
      userId: ctx.userId,
      taskType: spec.taskType,
      llmProviderConfigId: config.id,
      modelName: config.modelName,
      status: 'running',
    })
    .returning();
  const taskRunId = run!.id;

  await writeAudit(db, {
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.userId,
    action: 'ai_task.started',
    resourceType: 'ai_task_run',
    resourceId: taskRunId,
    metadata: { taskType: spec.taskType },
  });

  const start = Date.now();
  const usage: CompletionUsage = { inputTokens: null, outputTokens: null };
  try {
    const apiKey = await readSecretForUse(db, masterKey, config.secretId);
    const provider = providerFor(config, apiKey, logger, usage);

    // The prompt builders wrap session/pageModel via asUntrustedData(), which
    // re-redacts the content before it ever reaches the provider.
    const built = spec.build(input);
    const raw = await provider.complete({
      system: built.system,
      user: built.user,
      maxTokens: built.maxTokens ?? config.maxOutputTokens,
    });
    const result = spec.shape(raw);

    await db
      .update(aiTaskRuns)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        durationMs: Date.now() - start,
        inputTokenCount: usage.inputTokens,
        outputTokenCount: usage.outputTokens,
      })
      .where(eq(aiTaskRuns.id, taskRunId));
    await db.insert(usageLogs).values({
      id: genId('usage'),
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      projectId: ctx.projectId ?? null,
      llmProviderConfigId: config.id,
      taskType: spec.taskType,
      modelName: config.modelName,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    await writeAudit(db, {
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      action: 'ai_task.completed',
      resourceType: 'ai_task_run',
      resourceId: taskRunId,
    });

    return { taskRunId, result, usage };
  } catch (err) {
    const status = err instanceof LLMError ? err.status : undefined;
    await db
      .update(aiTaskRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        durationMs: Date.now() - start,
        errorCode: status ? String(status) : 'error',
        errorMessageSafe: status === 504 ? 'Provider timed out' : 'Provider call failed',
      })
      .where(eq(aiTaskRuns.id, taskRunId));
    await writeAudit(db, {
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.userId,
      action: 'ai_task.failed',
      resourceType: 'ai_task_run',
      resourceId: taskRunId,
      metadata: { status: status ?? null, taskType: spec.taskType },
    });
    throw new ApiError(
      502,
      'AI task failed. The selected AI provider could not be reached. Try again or ask your workspace admin to check the provider settings.',
      'ai_task_failed',
      { taskRunId },
    );
  }
}

// --- Task definitions ---------------------------------------------------------

export interface BugReportInput {
  session: unknown;
  pageModel?: unknown;
  userNote?: string;
  sessionId?: string;
}

export interface BugReportResult {
  taskRunId: string;
  bugReport: { content: string; format: 'markdown' };
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export async function runGenerateBugReport(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  input: BugReportInput,
): Promise<BugReportResult> {
  const { taskRunId, result, usage } = await runAiTask(
    deps,
    { ...ctx, sessionId: ctx.sessionId ?? input.sessionId },
    {
      taskType: 'generate_bug_report',
      build: (i: BugReportInput) => ({
        system: bugReportSystem(),
        user: bugReportUser(
          i.session as TestSession,
          (i.pageModel ?? null) as PageModel | null,
          i.userNote ?? '',
        ),
      }),
      shape: (raw) => ({ content: stripFences(raw), format: 'markdown' as const }),
    },
    input,
  );
  return { taskRunId, bugReport: result, usage };
}

export interface AnalyzePageInput {
  pageModel: unknown;
  question?: string;
}

export interface AnalyzePageResult {
  taskRunId: string;
  result: { summary: string; risks: string[]; suggestedTests: string[] };
}

export async function runAnalyzePage(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  input: AnalyzePageInput,
): Promise<AnalyzePageResult> {
  const { taskRunId, result } = await runAiTask(
    deps,
    ctx,
    {
      taskType: 'analyze_page',
      build: (i: AnalyzePageInput) => ({
        system: analyzeSystem(),
        user: analyzeUser(i.pageModel as PageModel, i.question),
        maxTokens: 2048,
      }),
      shape: (raw): { summary: string; risks: string[]; suggestedTests: string[] } => {
        const parsed = parseJsonLoose<{
          summary: string;
          risks: string[];
          suggestedTests: string[];
        }>(raw);
        if (!parsed) {
          // Truncated/malformed JSON: show prose, but never leak broken JSON.
          const looksJson = raw.trim().startsWith('{');
          return {
            summary: looksJson
              ? 'The model returned malformed or truncated JSON. Try again, or raise the provider max output tokens.'
              : raw.trim(),
            risks: [],
            suggestedTests: [],
          };
        }
        return {
          summary: parsed.summary,
          risks: parsed.risks ?? [],
          suggestedTests: parsed.suggestedTests ?? [],
        };
      },
    },
    input,
  );
  return { taskRunId, result };
}

export interface TestCasesInput {
  pageModel: unknown;
  focus?: string;
}

export interface ArtifactResult {
  taskRunId: string;
  result: { artifactId: string; type: string; format: string; content: string };
}

export async function runGenerateTestCases(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  input: TestCasesInput,
): Promise<ArtifactResult> {
  const { taskRunId, result } = await runAiTask(
    deps,
    ctx,
    {
      taskType: 'generate_test_cases',
      build: (i: TestCasesInput) => ({
        system: testCasesSystem(),
        user: testCasesUser(i.pageModel as PageModel, i.focus),
        maxTokens: 3072,
      }),
      shape: (raw) => ({
        artifactId: artifactId(),
        type: 'test_cases',
        format: 'markdown',
        content: stripFences(raw),
      }),
    },
    input,
  );
  return { taskRunId, result };
}

export interface EnrichPlaywrightResult {
  taskRunId: string;
  content: string;
}

export async function runEnrichPlaywright(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  input: { specContent: string },
): Promise<EnrichPlaywrightResult> {
  const { taskRunId, result } = await runAiTask(
    deps,
    ctx,
    {
      taskType: 'enrich_playwright',
      build: (i: { specContent: string }) => ({
        system: playwrightEnrichSystem(),
        user: playwrightEnrichUser(i.specContent),
        maxTokens: 2048,
      }),
      shape: (raw) => ({ content: stripFences(raw) }),
    },
    input,
  );
  return { taskRunId, content: result.content };
}
