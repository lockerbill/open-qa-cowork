import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { environmentProfiles, llmProviderConfigs, projects } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import { flagsForEnv, type EnvFlags } from './env-defaults.js';

export type Project = typeof projects.$inferSelect;
export type EnvironmentProfile = typeof environmentProfiles.$inferSelect;

/** Create a project. `key` is normalized to uppercase and unique per workspace. */
export async function createProject(
  db: Database,
  params: {
    workspaceId: string;
    actorUserId: string;
    name: string;
    key: string;
    description?: string;
    defaultLlmProviderConfigId?: string;
  },
): Promise<Project> {
  const key = params.key.trim().toUpperCase();
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, params.workspaceId), eq(projects.key, key)));
  if (existing) {
    throw new ApiError(409, `A project with key "${key}" already exists`, 'project_key_conflict');
  }
  if (params.defaultLlmProviderConfigId) {
    await assertProviderInWorkspace(db, params.workspaceId, params.defaultLlmProviderConfigId);
  }
  const [project] = await db
    .insert(projects)
    .values({
      id: genId('proj'),
      workspaceId: params.workspaceId,
      name: params.name,
      key,
      description: params.description ?? null,
      defaultLlmProviderConfigId: params.defaultLlmProviderConfigId ?? null,
      createdByUserId: params.actorUserId,
    })
    .returning();
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'project.created',
    resourceType: 'project',
    resourceId: project!.id,
    metadata: { key, name: params.name },
  });
  return project!;
}

export async function listProjects(db: Database, workspaceId: string): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
}

/** Fetch a project scoped to its workspace, or throw 404 (hides cross-tenant existence). */
export async function getProjectForWorkspace(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<Project> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  if (!project) throw new ApiError(404, 'Project not found');
  return project;
}

/** Update mutable project fields. Validates referenced env/provider belong to the project/workspace. */
export async function updateProject(
  db: Database,
  params: {
    workspaceId: string;
    projectId: string;
    actorUserId: string;
    patch: {
      name?: string;
      description?: string;
      defaultEnvironmentId?: string;
      defaultLlmProviderConfigId?: string | null;
      redactionPolicyId?: string | null;
    };
  },
): Promise<Project> {
  await getProjectForWorkspace(db, params.workspaceId, params.projectId);
  const { patch } = params;

  if (patch.defaultEnvironmentId !== undefined) {
    const [env] = await db
      .select({ id: environmentProfiles.id })
      .from(environmentProfiles)
      .where(
        and(
          eq(environmentProfiles.id, patch.defaultEnvironmentId),
          eq(environmentProfiles.projectId, params.projectId),
        ),
      );
    if (!env) throw new ApiError(400, 'defaultEnvironmentId does not belong to this project');
  }
  if (patch.defaultLlmProviderConfigId) {
    await assertProviderInWorkspace(db, params.workspaceId, patch.defaultLlmProviderConfigId);
  }

  const [updated] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, params.projectId))
    .returning();
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'project.updated',
    resourceType: 'project',
    resourceId: params.projectId,
    metadata: { fields: Object.keys(patch) },
  });
  return updated!;
}

/** Create an environment under a project. Seeds safe flags by name, then applies overrides. */
export async function createEnvironment(
  db: Database,
  params: {
    workspaceId: string;
    projectId: string;
    actorUserId: string;
    name: string;
    displayName?: string;
    baseUrl?: string;
    overrides?: Partial<EnvFlags>;
  },
): Promise<EnvironmentProfile> {
  await getProjectForWorkspace(db, params.workspaceId, params.projectId);
  const flags = { ...flagsForEnv(params.name), ...stripUndefined(params.overrides ?? {}) };
  const [env] = await db
    .insert(environmentProfiles)
    .values({
      id: genId('env'),
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      name: params.name,
      displayName: params.displayName ?? params.name,
      baseUrl: params.baseUrl ?? null,
      ...flags,
    })
    .returning();
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'environment.created',
    resourceType: 'environment_profile',
    resourceId: env!.id,
    metadata: { name: params.name },
  });
  return env!;
}

export async function listEnvironments(
  db: Database,
  workspaceId: string,
  projectId: string,
): Promise<EnvironmentProfile[]> {
  await getProjectForWorkspace(db, workspaceId, projectId);
  return db.select().from(environmentProfiles).where(eq(environmentProfiles.projectId, projectId));
}

/**
 * Match a tab URL to a configured environment in the workspace. Compares the
 * URL against each environment's baseUrl by origin equality or path prefix; the
 * longest matching baseUrl wins. Returns null when nothing matches (no wildcards
 * this milestone).
 */
export async function resolveUrlToEnvironment(
  db: Database,
  workspaceId: string,
  url: string,
): Promise<{ project: Project; environment: EnvironmentProfile } | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const envs = await db
    .select()
    .from(environmentProfiles)
    .where(
      and(eq(environmentProfiles.workspaceId, workspaceId), isNotNull(environmentProfiles.baseUrl)),
    );

  let best: EnvironmentProfile | undefined;
  for (const env of envs) {
    const base = env.baseUrl!;
    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      continue;
    }
    const originMatch = baseUrl.origin === target.origin;
    const prefixMatch = target.href.startsWith(base);
    if (originMatch || prefixMatch) {
      if (!best || (best.baseUrl?.length ?? 0) < base.length) best = env;
    }
  }
  if (!best) return null;
  const project = await getProjectForWorkspace(db, workspaceId, best.projectId);
  return { project, environment: best };
}

/** Ensure an LLM provider config exists in this workspace, else 400. */
async function assertProviderInWorkspace(
  db: Database,
  workspaceId: string,
  configId: string,
): Promise<void> {
  const [config] = await db
    .select({ id: llmProviderConfigs.id })
    .from(llmProviderConfigs)
    .where(
      and(eq(llmProviderConfigs.id, configId), eq(llmProviderConfigs.workspaceId, workspaceId)),
    );
  if (!config) {
    throw new ApiError(400, 'defaultLlmProviderConfigId does not belong to this workspace');
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
