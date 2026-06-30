import { Router } from 'express';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { ApiError } from '../../http/errors.js';
import { createWorkspaceSchema, inviteMemberSchema } from '../../http/schemas.js';
import { writeAudit } from '../../audit/index.js';
import { authMiddleware, requireMember } from '../auth/middleware.js';
import { getUserByEmail } from '../auth/service.js';
import {
  addMember,
  createWorkspace,
  getMembership,
  getWorkspaceForUser,
  listWorkspacesForUser,
} from './service.js';

/** /api/workspaces — create/list/get workspaces and invite members. */
export function workspacesRouter(db: Database, jwtSecret: string): Router {
  const router = Router();
  router.use(authMiddleware(jwtSecret));

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = createWorkspaceSchema.parse(req.body);
      const { workspace } = await createWorkspace(db, { userId: req.user!.id, name: body.name });
      res.status(201).json({ id: workspace.id, name: workspace.name, role: 'owner' });
    }),
  );

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const rows = await listWorkspacesForUser(db, req.user!.id);
      res.json({
        workspaces: rows.map((r) => ({ id: r.workspace.id, name: r.workspace.name, role: r.role })),
      });
    }),
  );

  router.get(
    '/:workspaceId',
    requireMember(db),
    asyncHandler(async (req, res) => {
      const { workspace, role } = await getWorkspaceForUser(
        db,
        req.params.workspaceId!,
        req.user!.id,
      );
      res.json({ id: workspace.id, name: workspace.name, slug: workspace.slug, role });
    }),
  );

  // Invite an existing user as a member (owner/admin only). Email sending is out
  // of scope for this milestone — this creates an `invited` membership record.
  router.post(
    '/:workspaceId/members/invite',
    requireMember(db, 'owner', 'admin'),
    asyncHandler(async (req, res) => {
      const body = inviteMemberSchema.parse(req.body);
      const invitee = await getUserByEmail(db, body.email);
      if (!invitee) {
        throw new ApiError(404, 'No user with that email — ask them to register first');
      }
      const existing = await getMembership(db, req.params.workspaceId!, invitee.id);
      if (existing) throw new ApiError(409, 'User is already a member of this workspace');

      const membership = await addMember(db, {
        workspaceId: req.params.workspaceId!,
        userId: invitee.id,
        role: body.role,
        status: 'invited',
        invitedByUserId: req.user!.id,
      });
      await writeAudit(db, {
        workspaceId: req.params.workspaceId!,
        actorUserId: req.user!.id,
        action: 'member.invited',
        resourceType: 'workspace_member',
        resourceId: membership.id,
        metadata: { email: body.email, role: body.role },
      });
      res.status(201).json({ id: membership.id, role: membership.role, status: membership.status });
    }),
  );

  return router;
}
