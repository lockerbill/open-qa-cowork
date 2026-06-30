import jwt from 'jsonwebtoken';

export interface AuthTokenPayload {
  sub: string; // user id
  email: string;
}

const TOKEN_TTL = '30d';

export function signToken(payload: AuthTokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: TOKEN_TTL });
}

/** Verify a JWT and return its payload, or throw if invalid/expired. */
export function verifyToken(token: string, secret: string): AuthTokenPayload {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
    throw new Error('malformed token');
  }
  return { sub: decoded.sub, email: String(decoded.email ?? '') };
}
