import { Router } from 'express';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { aiGenerateBugReportSchema } from '../../http/schemas.js';
import type { Logger } from '../../logging/logger.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { AI_TASK_ROLES } from '../rbac.js';
import { runGenerateBugReport } from './orchestrator.js';

/**
 * /api/workspaces/:workspaceId/ai/tasks — product-level AI task endpoints. The
 * extension calls these (never a model endpoint directly). Viewers are excluded
 * by AI_TASK_ROLES.
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

  router.post(
    '/generate-bug-report',
    requireMember(db, ...AI_TASK_ROLES),
    asyncHandler(async (req, res) => {
      const body = aiGenerateBugReportSchema.parse(req.body);
      const result = await runGenerateBugReport(
        { db, masterKey, logger, allowPrivateHosts },
        {
          workspaceId: req.params.workspaceId!,
          userId: req.user!.id,
          projectId: body.projectId,
          environmentId: body.environmentId,
        },
        body,
      );
      res.json(result);
    }),
  );

  return router;
}
