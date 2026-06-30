import { eq } from 'drizzle-orm';
import type { PageModel, TestSession } from '@qa-copilot/shared';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { aiTaskRuns, usageLogs } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import { stripFences } from '../../http/util.js';
import type { Logger } from '../../logging/logger.js';
import { LLMError, type LLMProvider } from '../../llm/types.js';
import { LoggingProvider } from '../../llm/logging-provider.js';
import {
  openAICompatibleCompleteWithUsage,
  type CompletionUsage,
} from '../../llm/openai-compatible.js';
import { bugReportSystem, bugReportUser } from '../../prompts/index.js';
import { readSecretForUse } from '../secrets/service.js';
import { assertSafeProviderUrl } from '../providers/ssrf.js';
import { resolveProviderConfig } from './resolver.js';

export interface AiTaskDeps {
  db: Database;
  masterKey: string;
  logger: Logger;
  allowPrivateHosts: boolean;
}

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
  const inner: LLMProvider = {
    name: 'openai_compatible',
    complete: async (opts) => {
      const { text, usage } = await openAICompatibleCompleteWithUsage(
        {
          baseUrl: config.baseUrl,
          apiKey,
          model: config.modelName,
          label: config.displayName,
          requireApiKey: true,
          timeoutMs: config.timeoutSeconds * 1000,
          redirect: 'error',
        },
        opts,
      );
      usageSink.inputTokens = usage.inputTokens;
      usageSink.outputTokens = usage.outputTokens;
      return text;
    },
  };
  return new LoggingProvider(inner, logger, config.modelName);
}

/**
 * Generate a bug report through the gateway: resolve the workspace provider,
 * decrypt its key, redact + build the prompt, call the provider, and record an
 * AiTaskRun + UsageLog + audit events. Records a failed run (with a correlation
 * id) before surfacing a safe error.
 */
export interface AiTaskContext {
  workspaceId: string;
  userId: string;
  projectId?: string;
  environmentId?: string;
}

export async function runGenerateBugReport(
  deps: AiTaskDeps,
  ctx: AiTaskContext,
  input: BugReportInput,
): Promise<BugReportResult> {
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
      sessionId: input.sessionId ?? null,
      userId: ctx.userId,
      taskType: 'generate_bug_report',
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
    metadata: { taskType: 'generate_bug_report' },
  });

  const start = Date.now();
  const usage: CompletionUsage = { inputTokens: null, outputTokens: null };
  try {
    const apiKey = await readSecretForUse(db, masterKey, config.secretId);
    const provider = providerFor(config, apiKey, logger, usage);

    // bugReportUser() wraps the session/pageModel via asUntrustedData(), which
    // re-redacts the content before it ever reaches the provider.
    const content = stripFences(
      await provider.complete({
        system: bugReportSystem(),
        user: bugReportUser(
          input.session as TestSession,
          (input.pageModel ?? null) as PageModel | null,
          input.userNote ?? '',
        ),
        maxTokens: config.maxOutputTokens,
      }),
    );

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
      taskType: 'generate_bug_report',
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

    return { taskRunId, bugReport: { content, format: 'markdown' }, usage };
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
      metadata: { status: status ?? null },
    });
    throw new ApiError(
      502,
      'Bug report generation failed. The selected AI provider could not be reached. Try again or ask your workspace admin to check the provider settings.',
      'ai_task_failed',
      { taskRunId },
    );
  }
}
