import { Router } from 'express';
import { buildPlaywrightSpec, type TestSession } from '@qa-copilot/shared';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import {
  aiAnalyzePageSchema,
  aiEnrichPlaywrightSchema,
  aiGenerateBugReportSchema,
  aiGenerateTestCasesSchema,
} from '../../http/schemas.js';
import { artifactId } from '../../http/util.js';
import type { Logger } from '../../logging/logger.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { AI_TASK_ROLES } from '../rbac.js';
import {
  runAnalyzePage,
  runEnrichPlaywright,
  runGenerateBugReport,
  runGenerateTestCases,
  type AiTaskContext,
} from './orchestrator.js';

/**
 * /api/workspaces/:workspaceId/ai/tasks — product-level AI task endpoints. The
 * extension calls these (never a model endpoint directly). Viewers are excluded
 * by AI_TASK_ROLES. The unauthed /api/generate/* endpoints remain as a fallback.
 */
export function aiTasksRouter(
  db: Database,
  jwtSecret: string,
  masterKey: string,
  logger: Logger,
  allowPrivateHosts: boolean,
): Router {
  const router = Router({ mergeParams: true });
  router.use(authMiddleware(jwtSecret));

  const deps = { db, masterKey, logger, allowPrivateHosts };
  const contextOf = (req: { params: Record<string, string | undefined>; user?: { id: string } }, body: {
    projectId?: string;
    environmentId?: string;
    sessionId?: string;
  }): AiTaskContext => ({
    workspaceId: req.params.workspaceId!,
    userId: req.user!.id,
    projectId: body.projectId,
    environmentId: body.environmentId,
    sessionId: body.sessionId,
  });

  router.post(
    '/generate-bug-report',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = aiGenerateBugReportSchema.parse(req.body);
      const result = await runGenerateBugReport(deps, contextOf(req, body), body);
      res.json(result);
    }),
  );

  router.post(
    '/analyze-page',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = aiAnalyzePageSchema.parse(req.body);
      const { result } = await runAnalyzePage(deps, contextOf(req, body), body);
      res.json(result);
    }),
  );

  router.post(
    '/generate-test-cases',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = aiGenerateTestCasesSchema.parse(req.body);
      const { result } = await runGenerateTestCases(deps, contextOf(req, body), body);
      res.json(result);
    }),
  );

  router.post(
    '/enrich-playwright',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = aiEnrichPlaywrightSchema.parse(req.body);
      const spec = buildPlaywrightSpec(body.session as unknown as TestSession);

      let content = spec.content;
      if (body.enrich) {
        try {
          const enriched = await runEnrichPlaywright(deps, contextOf(req, body), {
            specContent: spec.content,
          });
          content = enriched.content;
        } catch {
          // Enrichment is best-effort; the failed run is recorded by runAiTask.
          content = spec.content;
        }
      }

      res.json({
        artifactId: artifactId(),
        type: 'playwright_test',
        format: 'typescript',
        filename: spec.filename,
        content,
        selectorWarnings: spec.selectorWarnings,
      });
    }),
  );

  return router;
}
