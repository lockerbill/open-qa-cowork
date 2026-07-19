import type { RequestHandler } from 'express';
import type { Database } from '../../db/client.js';
import { ApiError } from '../../http/errors.js';
import { asyncHandler } from '../../http/async-handler.js';
import { getMembership } from '../workspaces/service.js';
import type { WorkspaceRole } from '../rbac.js';
import { verifyToken } from './jwt.js';

/** Require a valid Bearer JWT; populates `req.user`. */
export function authMiddleware(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next(new ApiError(401, 'Authentication required'));
      return;
    }
    try {
      const payload = verifyToken(header.slice(7), jwtSecret);
      req.user = { id: payload.sub, email: payload.email };
      next();
    } catch {
      next(new ApiError(401, 'Invalid or expired token'));
    }
  };
}

/**
 * Require the authenticated user to be a member of `:workspaceId`. If
 * `allowedRoles` is non-empty, also require one of those roles. Populates
 * `req.membership`. Non-members get 404 so workspace existence never leaks.
 */
export function requireMember(db: Database, ...allowedRoles: WorkspaceRole[]): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (!req.user) throw new ApiError(401, 'Authentication required');
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) throw new ApiError(400, 'workspaceId is required');

    const membership = await getMembership(db, workspaceId, req.user.id);
    if (!membership || membership.status === 'disabled') {
      throw new ApiError(404, 'Workspace not found');
    }
    // Invited members exist but have not accepted yet — they know the workspace
    // exists (they were invited), so a 403 leaks nothing.
    if (membership.status === 'invited') {
      throw new ApiError(403, 'Accept your workspace invite before accessing it');
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role as WorkspaceRole)) {
      throw new ApiError(403, 'You do not have permission to perform this action');
    }
    req.membership = membership;
    next();
  });
}
