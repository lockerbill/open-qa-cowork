import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { llmProviderConfigs, workspaces } from '../../db/schema.js';
import { ApiError } from '../../http/errors.js';
import type { LlmProviderConfig } from '../providers/service.js';

/**
 * Resolve the LLM provider config for a workspace. For this milestone only the
 * workspace default is supported (project/session/user tiers are deferred).
 */
export async function resolveProviderConfig(
  db: Database,
  workspaceId: string,
): Promise<LlmProviderConfig> {
  const [ws] = await db
    .select({ defaultId: workspaces.defaultLlmProviderConfigId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws?.defaultId) {
    throw new ApiError(
      409,
      'No AI provider is configured for this workspace. Ask a workspace admin to configure a BYO LLM provider.',
      'no_provider',
    );
  }
  const [config] = await db
    .select()
    .from(llmProviderConfigs)
    .where(
      and(eq(llmProviderConfigs.id, ws.defaultId), eq(llmProviderConfigs.workspaceId, workspaceId)),
    );
  if (!config || !config.enabled) {
    throw new ApiError(
      409,
      'The workspace default AI provider is unavailable. Ask a workspace admin to check the provider settings.',
      'no_provider',
    );
  }
  return config;
}
