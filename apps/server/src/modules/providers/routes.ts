import { Router } from 'express';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import {
  createLlmProviderSchema,
  rotateProviderSecretSchema,
  updateLlmProviderSchema,
} from '../../http/schemas.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { PROVIDER_ADMIN_ROLES } from '../rbac.js';
import {
  createProviderConfig,
  deleteProviderConfig,
  getWorkspaceDefaultId,
  listProviderConfigs,
  rotateProviderSecret,
  setWorkspaceDefault,
  toPublicConfig,
  updateProviderConfig,
  validateProviderConfig,
} from './service.js';

/**
 * /api/workspaces/:workspaceId/llm-providers — manage BYO LLM provider configs.
 * Mutations require owner/admin; listing is allowed for any member (the API key
 * is never included in any response).
 */
export function providersRouter(
  db: Database,
  jwtSecret: string,
  masterKey: string,
  allowPrivateHosts: boolean,
): Router {
  const router = Router({ mergeParams: true });
  router.use(authMiddleware(jwtSecret));

  const ws = (req: { params: Record<string, string | undefined> }) => req.params.workspaceId!;

  router.get(
    '/',
    requireMember(db),
    asyncHandler(async (req, res) => {
      res.json({ providers: await listProviderConfigs(db, ws(req)) });
    }),
  );

  router.post(
    '/',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const body = createLlmProviderSchema.parse(req.body);
      const config = await createProviderConfig(db, masterKey, {
        workspaceId: ws(req),
        actorUserId: req.user!.id,
        allowPrivateHosts,
        ...body,
      });
      res.status(201).json(toPublicConfig(config, await getWorkspaceDefaultId(db, ws(req))));
    }),
  );

  router.patch(
    '/:providerId',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const patch = updateLlmProviderSchema.parse(req.body);
      const config = await updateProviderConfig(db, {
        workspaceId: ws(req),
        id: req.params.providerId!,
        actorUserId: req.user!.id,
        allowPrivateHosts,
        patch,
      });
      res.json(toPublicConfig(config, await getWorkspaceDefaultId(db, ws(req))));
    }),
  );

  router.delete(
    '/:providerId',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      await deleteProviderConfig(db, {
        workspaceId: ws(req),
        id: req.params.providerId!,
        actorUserId: req.user!.id,
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/:providerId/rotate-secret',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const body = rotateProviderSecretSchema.parse(req.body);
      await rotateProviderSecret(db, masterKey, {
        workspaceId: ws(req),
        id: req.params.providerId!,
        apiKey: body.apiKey,
        actorUserId: req.user!.id,
      });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/:providerId/validate',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      const result = await validateProviderConfig(db, masterKey, {
        workspaceId: ws(req),
        id: req.params.providerId!,
        actorUserId: req.user!.id,
        allowPrivateHosts,
      });
      res.json(result);
    }),
  );

  router.post(
    '/:providerId/set-default',
    requireMember(db, ...PROVIDER_ADMIN_ROLES),
    asyncHandler(async (req, res) => {
      await setWorkspaceDefault(db, {
        workspaceId: ws(req),
        id: req.params.providerId!,
        actorUserId: req.user!.id,
      });
      res.json({ ok: true });
    }),
  );

  return router;
}
