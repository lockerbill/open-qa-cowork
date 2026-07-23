/**
 * POST /api/workspaces/:workspaceId/auto/step — the stateless decision gateway
 * for Auto Test Mode (auto-test-mode-spec §8). Follows the ai-tasks pattern:
 * workspace-scoped auth, AI_TASK_ROLES RBAC, layered provider resolution, SSRF
 * guard, server-side keys, and metadata-only logging. Holds no run state —
 * everything needed to decide travels in the StepRequest.
 *
 * Contract: 200 {action} | 422 {error:'invalid_action', detail, modelRaw?}
 * | 502 {error:'provider_error'} | 504 {error:'provider_timeout'}.
 * `modelRaw` appears only when AUTO_STEP_DEBUG=1.
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import type { StepRequest, StepResponse } from '@qa-copilot/shared/auto';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { aiTaskRuns, usageLogs } from '../../db/schema.js';
import { asyncHandler } from '../../http/async-handler.js';
import { autoStepSchema } from '../../http/schemas.js';
import type { Logger } from '../../logging/logger.js';
import { LLMError } from '../../llm/types.js';
import type { OpenAICompatParams } from '../../llm/openai-compatible.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { resolveProviderConfig } from '../ai-tasks/resolver.js';
import { assertSafeProviderUrl } from '../providers/ssrf.js';
import { AI_TASK_ROLES } from '../rbac.js';
import { readSecretForUse } from '../secrets/service.js';
import { autoStepSystem, autoStepUser } from './prompt.js';
import { decideCandidate, localModelExtraBody, type DecideOutcome } from './providers.js';
import { validateCandidate } from './validate.js';

/** Provider timeout for one step decision (§8.1) — local models on CPU are slow. */
export const AUTO_STEP_TIMEOUT_MS = 60_000;

/**
 * Per-call output-token floor. An action is tiny, but reasoning models
 * (Hunyuan, Qwen3, …) spend output budget thinking first — at the 2048
 * default they hit finish_reason=length with no content at all. Like
 * LocalProvider's LOCAL_MAX_TOKENS, this floor only ever raises the
 * provider-config cap, never lowers it.
 */
export const AUTO_STEP_MIN_TOKENS = 4096;

export function autoRouter(
  db: Database,
  jwtSecret: string,
  masterKey: string,
  logger: Logger,
  allowPrivateHosts: boolean,
): Router {
  const router = Router({ mergeParams: true });
  router.use(authMiddleware(jwtSecret));

  router.post(
    '/step',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = autoStepSchema.parse(req.body);
      const workspaceId = req.params.workspaceId!;
      const userId = req.user!.id;
      const { projectId, environmentId, ...stepRequest } = body;

      const config = await resolveProviderConfig(db, workspaceId, projectId);
      // Re-check the stored base URL before any server-side request (SSRF guard).
      await assertSafeProviderUrl(config.baseUrl, { allowPrivate: allowPrivateHosts });
      const apiKey = await readSecretForUse(db, masterKey, config.secretId);

      const params: OpenAICompatParams = {
        baseUrl: config.baseUrl,
        apiKey,
        model: config.modelName,
        label: config.displayName,
        requireApiKey: true,
        timeoutMs: AUTO_STEP_TIMEOUT_MS,
        redirect: 'error',
        // Private-host (local) providers: disable reasoning-model thinking so
        // the output budget is spent on the action, not the scratchpad.
        extraBody: localModelExtraBody(config.baseUrl),
      };
      const prompt = {
        system: autoStepSystem(),
        user: autoStepUser(stepRequest as StepRequest),
      };

      const [run] = await db
        .insert(aiTaskRuns)
        .values({
          id: genId('taskrun'),
          workspaceId,
          projectId: projectId ?? null,
          environmentId: environmentId ?? null,
          userId,
          taskType: 'auto_step',
          llmProviderConfigId: config.id,
          modelName: config.modelName,
          status: 'running',
        })
        .returning();
      const taskRunId = run!.id;
      const start = Date.now();

      let outcome: DecideOutcome;
      try {
        outcome = await decideCandidate(
          params,
          prompt,
          logger,
          Math.max(config.maxOutputTokens, AUTO_STEP_MIN_TOKENS),
        );
      } catch (err) {
        const timeout = err instanceof LLMError && err.status === 504;
        await db
          .update(aiTaskRuns)
          .set({
            status: 'failed',
            completedAt: new Date(),
            durationMs: Date.now() - start,
            errorCode: timeout ? '504' : '502',
            errorMessageSafe: timeout ? 'Provider timed out' : 'Provider call failed',
          })
          .where(eq(aiTaskRuns.id, taskRunId));
        logger.info(
          {
            event: 'auto.step',
            workspaceId,
            taskRunId,
            ok: false,
            timeout,
            err: err instanceof Error ? err.message : String(err),
          },
          'auto step provider failure',
        );
        res
          .status(timeout ? 504 : 502)
          .json({ error: timeout ? 'provider_timeout' : 'provider_error' });
        return;
      }

      await db
        .update(aiTaskRuns)
        .set({
          status: 'succeeded',
          completedAt: new Date(),
          durationMs: Date.now() - start,
          inputTokenCount: outcome.usage.inputTokens,
          outputTokenCount: outcome.usage.outputTokens,
        })
        .where(eq(aiTaskRuns.id, taskRunId));
      await db.insert(usageLogs).values({
        id: genId('usage'),
        workspaceId,
        userId,
        projectId: projectId ?? null,
        llmProviderConfigId: config.id,
        taskType: 'auto_step',
        modelName: config.modelName,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
      });

      const validated = validateCandidate(outcome.candidate);
      // Metadata only — never the prompt, observation, or model payloads.
      logger.info(
        {
          event: 'auto.step',
          workspaceId,
          taskRunId,
          ok: validated.ok,
          path: outcome.path,
          actionType: validated.ok ? validated.action.type : null,
          historyLength: stepRequest.history.length,
          observationChars: stepRequest.observation.serialized.length,
          stepsRemaining: stepRequest.stepsRemaining,
          correction: Boolean(stepRequest.correction),
          durationMs: Date.now() - start,
        },
        'auto step decided',
      );

      if (!validated.ok) {
        // The compact issue list may quote a field value — debug level only.
        logger.debug(
          { event: 'auto.step.invalid', workspaceId, taskRunId, detail: validated.detail },
          'auto step invalid action',
        );
        res.status(422).json({
          error: 'invalid_action',
          detail: validated.detail,
          ...(process.env.AUTO_STEP_DEBUG === '1' ? { modelRaw: outcome.modelRaw } : {}),
        });
        return;
      }
      const response: StepResponse = { action: validated.action };
      res.json(response);
    }),
  );

  return router;
}
