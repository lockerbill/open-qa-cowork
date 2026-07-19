import type { WorkspaceMember } from '../modules/workspaces/service.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by authMiddleware once a valid JWT is presented. */
      user?: { id: string; email: string };
      /** Set by requireMember once workspace membership is verified. */
      membership?: WorkspaceMember;
    }
  }
}

export {};
