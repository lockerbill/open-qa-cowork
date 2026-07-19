import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmProviderConfigs, projects, workspaces } from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import type { LlmProviderConfig } from '../providers/service.js';

/**
 * Resolve the LLM provider config for an AI task using layered precedence:
 * project default → workspace default (spec §9; session/user tiers deferred).
 * A project default that is missing or disabled falls back to the workspace
 * default rather than hard-failing.
 */
export async function resolveProviderConfig(
  db: Database,
  workspaceId: string,
  projectId?: string | null,
): Promise<LlmProviderConfig> {
  const candidateIds: string[] = [];

  if (projectId) {
    const [proj] = await db
      .select({ defaultId: projects.defaultLlmProviderConfigId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
    if (proj?.defaultId) candidateIds.push(proj.defaultId);
  }

  const [ws] = await db
    .select({ defaultId: workspaces.defaultLlmProviderConfigId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (ws?.defaultId) candidateIds.push(ws.defaultId);

  for (const id of candidateIds) {
    const [config] = await db
      .select()
      .from(llmProviderConfigs)
      .where(and(eq(llmProviderConfigs.id, id), eq(llmProviderConfigs.workspaceId, workspaceId)));
    if (config && config.enabled) return config;
  }

  throw new ApiError(
    409,
    'No AI provider is configured for this workspace. Ask a workspace admin to configure a BYO LLM provider.',
    'no_provider',
  );
}
