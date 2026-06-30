import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { workspaceMembers, workspaces } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import type { WorkspaceRole } from '../rbac.js';

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${genId('').slice(1, 7)}`;
}

/**
 * Create a workspace + owner membership + audit event using an existing db or
 * transaction handle. Callers that need atomicity with other writes (e.g. user
 * registration) pass their transaction here.
 */
export async function createWorkspaceTx(
  db: Database,
  params: { userId: string; name: string; role?: WorkspaceRole },
): Promise<{ workspace: Workspace; membership: WorkspaceMember }> {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      id: genId('ws'),
      name: params.name,
      slug: slugify(params.name),
      createdByUserId: params.userId,
    })
    .returning();
  const [membership] = await db
    .insert(workspaceMembers)
    .values({
      id: genId('mbr'),
      workspaceId: workspace!.id,
      userId: params.userId,
      role: params.role ?? 'owner',
      status: 'active',
    })
    .returning();
  await writeAudit(db, {
    workspaceId: workspace!.id,
    actorUserId: params.userId,
    action: 'workspace.created',
    resourceType: 'workspace',
    resourceId: workspace!.id,
    metadata: { name: params.name },
  });
  return { workspace: workspace!, membership: membership! };
}

/** Create a workspace and make `userId` its owner (or `role`). Writes an audit event. */
export async function createWorkspace(
  db: Database,
  params: { userId: string; name: string; role?: WorkspaceRole },
): Promise<{ workspace: Workspace; membership: WorkspaceMember }> {
  return db.transaction((tx) => createWorkspaceTx(tx as unknown as Database, params));
}

/** Add (or invite) a member to a workspace. */
export async function addMember(
  db: Database,
  params: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    status?: 'invited' | 'active';
    invitedByUserId?: string;
  },
): Promise<WorkspaceMember> {
  const [membership] = await db
    .insert(workspaceMembers)
    .values({
      id: genId('mbr'),
      workspaceId: params.workspaceId,
      userId: params.userId,
      role: params.role,
      status: params.status ?? 'active',
      invitedByUserId: params.invitedByUserId ?? null,
    })
    .returning();
  return membership!;
}

/** Membership of `userId` in `workspaceId`, or undefined if not a member. */
export async function getMembership(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember | undefined> {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return membership;
}

/** All workspaces `userId` belongs to, with their role in each. */
export async function listWorkspacesForUser(
  db: Database,
  userId: string,
): Promise<Array<{ workspace: Workspace; role: WorkspaceRole }>> {
  const rows = await db
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => ({ workspace: r.workspace, role: r.role as WorkspaceRole }));
}

/** Fetch a workspace the user can access, or throw 404 (never reveal existence cross-tenant). */
export async function getWorkspaceForUser(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspace: Workspace; role: WorkspaceRole }> {
  const membership = await getMembership(db, workspaceId, userId);
  if (!membership) {
    throw new ApiError(404, 'Workspace not found');
  }
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new ApiError(404, 'Workspace not found');
  }
  return { workspace, role: membership.role as WorkspaceRole };
}
