import { Router } from 'express';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import {
  createEnvironmentSchema,
  createProjectSchema,
  resolveUrlQuerySchema,
  updateProjectSchema,
} from '../../http/schemas.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { PROJECT_ADMIN_ROLES } from '../rbac.js';
import {
  createEnvironment,
  createProject,
  getProjectForWorkspace,
  listEnvironments,
  listProjects,
  resolveUrlToEnvironment,
  updateProject,
} from './service.js';

/**
 * /api/workspaces/:workspaceId/projects — project + environment CRUD. Mutations
 * require an owner/admin/qa_lead role; reads are open to any active member.
 */
export function projectsRouter(db: Database, jwtSecret: string): Router {
  const router = Router({ mergeParams: true });
  router.use(authMiddleware(jwtSecret));

  router.post(
    '/',
    requireMember(db, ...PROJECT_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const body = createProjectSchema.parse(req.body);
      const project = await createProject(db, {
        workspaceId: req.params.workspaceId!,
        actorUserId: req.user!.id,
        ...body,
      });
      res.status(201).json({ id: project.id, key: project.key, name: project.name });
    }),
  );

  router.get(
    '/',
    requireMember(db),
    asyncHandler(async (req, res) => {
      const projects = await listProjects(db, req.params.workspaceId!);
      res.json({ projects });
    }),
  );

  router.get(
    '/:projectId',
    requireMember(db),
    asyncHandler(async (req, res) => {
      const project = await getProjectForWorkspace(db, req.params.workspaceId!, req.params.projectId!);
      res.json(project);
    }),
  );

  router.patch(
    '/:projectId',
    requireMember(db, ...PROJECT_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const patch = updateProjectSchema.parse(req.body);
      const project = await updateProject(db, {
        workspaceId: req.params.workspaceId!,
        projectId: req.params.projectId!,
        actorUserId: req.user!.id,
        patch,
      });
      res.json(project);
    }),
  );

  router.post(
    '/:projectId/environments',
    requireMember(db, ...PROJECT_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const { name, displayName, baseUrl, ...overrides } = createEnvironmentSchema.parse(req.body);
      const env = await createEnvironment(db, {
        workspaceId: req.params.workspaceId!,
        projectId: req.params.projectId!,
        actorUserId: req.user!.id,
        name,
        displayName,
        baseUrl,
        overrides,
      });
      res.status(201).json(env);
    }),
  );

  router.get(
    '/:projectId/environments',
    requireMember(db),
    asyncHandler(async (req, res) => {
      const environments = await listEnvironments(db, req.params.workspaceId!, req.params.projectId!);
      res.json({ environments });
    }),
  );

  return router;
}

/**
 * /api/workspaces/:workspaceId/resolve — map a tab URL to a project/environment.
 * A null match is a normal 200 answer (not 404).
 */
export function resolveRouter(db: Database, jwtSecret: string): Router {
  const router = Router({ mergeParams: true });
  router.use(authMiddleware(jwtSecret));

  router.get(
    '/',
    requireMember(db),
    asyncHandler(async (req, res) => {
      const { url } = resolveUrlQuerySchema.parse(req.query);
      const match = await resolveUrlToEnvironment(db, req.params.workspaceId!, url);
      res.json({ match });
    }),
  );

  return router;
}
