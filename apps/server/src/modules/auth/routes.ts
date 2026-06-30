import { Router } from 'express';
import type { Database } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { ApiError } from '../../http/errors.js';
import { loginSchema, registerSchema } from '../../http/schemas.js';
import { authMiddleware } from './middleware.js';
import { signToken } from './jwt.js';
import { authenticate, getUserById, registerUser, toPublicUser } from './service.js';

/** /api/auth — register, login, me. */
export function authRouter(db: Database, jwtSecret: string): Router {
  const router = Router();

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const body = registerSchema.parse(req.body);
      const { user, workspace } = await registerUser(db, body);
      const token = signToken({ sub: user.id, email: user.email }, jwtSecret);
      res.status(201).json({
        token,
        user: toPublicUser(user),
        workspace: { id: workspace.id, name: workspace.name, role: 'owner' },
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = loginSchema.parse(req.body);
      const user = await authenticate(db, body);
      const token = signToken({ sub: user.id, email: user.email }, jwtSecret);
      res.json({ token, user: toPublicUser(user) });
    }),
  );

  router.get(
    '/me',
    authMiddleware(jwtSecret),
    asyncHandler(async (req, res) => {
      const user = await getUserById(db, req.user!.id);
      if (!user) throw new ApiError(401, 'Authentication required');
      res.json({ user: toPublicUser(user) });
    }),
  );

  return router;
}
