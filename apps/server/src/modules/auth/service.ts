import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { externalIdentities, users } from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import { createWorkspaceTx, type Workspace } from '../workspaces/service.js';
import { hashPassword, verifyPassword } from './password.js';

export type User = typeof users.$inferSelect;

/** Public-safe view of a user (never includes credentials). */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/**
 * Register a new user with email + password and auto-create their personal
 * workspace (owner). All writes are atomic.
 */
export async function registerUser(
  db: Database,
  params: { email: string; password: string; displayName?: string },
): Promise<{ user: User; workspace: Workspace }> {
  const email = params.email.trim().toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing.length > 0) {
    throw new ApiError(409, 'An account with this email already exists', 'email_taken');
  }
  const passwordHash = await hashPassword(params.password);
  const displayName = params.displayName?.trim() || email.split('@')[0]!;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [user] = await txDb
      .insert(users)
      .values({ id: genId('user'), email, displayName })
      .returning();
    await txDb.insert(externalIdentities).values({
      id: genId('idn'),
      userId: user!.id,
      provider: 'password',
      email,
      passwordHash,
    });
    const { workspace } = await createWorkspaceTx(txDb, {
      userId: user!.id,
      name: `${displayName}'s Workspace`,
    });
    return { user: user!, workspace };
  });
}

/** Verify email + password, update lastLoginAt, and return the user. */
export async function authenticate(
  db: Database,
  params: { email: string; password: string },
): Promise<User> {
  const email = params.email.trim().toLowerCase();
  const invalid = new ApiError(401, 'Invalid email or password', 'invalid_credentials');

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user || user.status !== 'active') throw invalid;

  const [identity] = await db
    .select()
    .from(externalIdentities)
    .where(eq(externalIdentities.userId, user.id));
  if (!identity?.passwordHash) throw invalid;

  const ok = await verifyPassword(params.password, identity.passwordHash);
  if (!ok) throw invalid;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return user;
}

/** Fetch a user by id, or undefined. */
export async function getUserById(db: Database, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

/** Fetch a user by (normalized) email, or undefined. */
export async function getUserByEmail(db: Database, email: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  return user;
}
