import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { llmProviderConfigs, workspaces } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import { LLMError } from '../../llm/types.js';
import { openAICompatibleComplete } from '../../llm/openai-compatible.js';
import { createSecret, readSecretForUse, rotateSecret } from '../secrets/service.js';
import { assertSafeProviderUrl } from './ssrf.js';

export type LlmProviderConfig = typeof llmProviderConfigs.$inferSelect;

/** Public view of a provider config — never exposes secretId or the API key. */
export interface PublicProviderConfig {
  id: string;
  scope: string;
  providerType: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  enabled: boolean;
  maxOutputTokens: number;
  temperature: number;
  timeoutSeconds: number;
  validationStatus: string;
  lastValidatedAt: Date | null;
  isWorkspaceDefault: boolean;
}

export function toPublicConfig(
  config: LlmProviderConfig,
  workspaceDefaultId: string | null,
): PublicProviderConfig {
  return {
    id: config.id,
    scope: config.scope,
    providerType: config.providerType,
    displayName: config.displayName,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    enabled: config.enabled,
    maxOutputTokens: config.maxOutputTokens,
    temperature: config.temperature,
    timeoutSeconds: config.timeoutSeconds,
    validationStatus: config.validationStatus,
    lastValidatedAt: config.lastValidatedAt,
    isWorkspaceDefault: workspaceDefaultId === config.id,
  };
}

async function getWorkspaceDefaultId(db: Database, workspaceId: string): Promise<string | null> {
  const [ws] = await db
    .select({ id: workspaces.defaultLlmProviderConfigId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws?.id ?? null;
}

/** Fetch a config scoped to a workspace, or throw 404. */
export async function getProviderConfig(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<LlmProviderConfig> {
  const [config] = await db
    .select()
    .from(llmProviderConfigs)
    .where(and(eq(llmProviderConfigs.id, id), eq(llmProviderConfigs.workspaceId, workspaceId)));
  if (!config) throw new ApiError(404, 'Provider config not found');
  return config;
}

/** Create a provider config, storing the API key in the secret vault. */
export async function createProviderConfig(
  db: Database,
  masterKey: string,
  params: {
    workspaceId: string;
    actorUserId: string;
    displayName: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    scope?: string;
    maxOutputTokens?: number;
    temperature?: number;
    timeoutSeconds?: number;
    allowPrivateHosts: boolean;
  },
): Promise<LlmProviderConfig> {
  await assertSafeProviderUrl(params.baseUrl, { allowPrivate: params.allowPrivateHosts });
  const secret = await createSecret(db, masterKey, {
    workspaceId: params.workspaceId,
    name: `${params.displayName} API key`,
    type: 'llm_api_key',
    value: params.apiKey,
    createdByUserId: params.actorUserId,
  });

  const [config] = await db
    .insert(llmProviderConfigs)
    .values({
      id: genId('llm'),
      workspaceId: params.workspaceId,
      scope: params.scope ?? 'workspace',
      providerType: 'openai_compatible',
      displayName: params.displayName,
      baseUrl: params.baseUrl,
      modelName: params.modelName,
      secretId: secret.id,
      maxOutputTokens: params.maxOutputTokens ?? 2048,
      temperature: params.temperature ?? 0.2,
      timeoutSeconds: params.timeoutSeconds ?? 60,
      createdByUserId: params.actorUserId,
    })
    .returning();

  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'llm_provider.created',
    resourceType: 'llm_provider_config',
    resourceId: config!.id,
    metadata: { displayName: params.displayName, modelName: params.modelName },
  });
  return config!;
}

/** List a workspace's provider configs as public views (no secrets). */
export async function listProviderConfigs(
  db: Database,
  workspaceId: string,
): Promise<PublicProviderConfig[]> {
  const defaultId = await getWorkspaceDefaultId(db, workspaceId);
  const rows = await db
    .select()
    .from(llmProviderConfigs)
    .where(eq(llmProviderConfigs.workspaceId, workspaceId));
  return rows.map((r) => toPublicConfig(r, defaultId));
}

/** Update mutable connection fields. Writes a `llm_provider.updated` audit event. */
export async function updateProviderConfig(
  db: Database,
  params: {
    workspaceId: string;
    id: string;
    actorUserId: string;
    allowPrivateHosts: boolean;
    patch: Partial<{
      displayName: string;
      baseUrl: string;
      modelName: string;
      maxOutputTokens: number;
      temperature: number;
      timeoutSeconds: number;
      enabled: boolean;
    }>;
  },
): Promise<LlmProviderConfig> {
  await getProviderConfig(db, params.workspaceId, params.id); // 404 if cross-workspace
  if (params.patch.baseUrl !== undefined) {
    await assertSafeProviderUrl(params.patch.baseUrl, { allowPrivate: params.allowPrivateHosts });
  }
  const [updated] = await db
    .update(llmProviderConfigs)
    .set({ ...params.patch, updatedAt: new Date() })
    .where(eq(llmProviderConfigs.id, params.id))
    .returning();
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'llm_provider.updated',
    resourceType: 'llm_provider_config',
    resourceId: params.id,
    metadata: { fields: Object.keys(params.patch) },
  });
  return updated!;
}

/** Replace the API key behind a provider config (re-encrypts in the vault). */
export async function rotateProviderSecret(
  db: Database,
  masterKey: string,
  params: { workspaceId: string; id: string; apiKey: string; actorUserId: string },
): Promise<void> {
  const config = await getProviderConfig(db, params.workspaceId, params.id);
  await rotateSecret(db, masterKey, {
    workspaceId: params.workspaceId,
    secretId: config.secretId,
    newValue: params.apiKey,
    actorUserId: params.actorUserId,
  });
}

/** Set the workspace's default provider config. Writes an audit event. */
export async function setWorkspaceDefault(
  db: Database,
  params: { workspaceId: string; id: string; actorUserId: string },
): Promise<void> {
  await getProviderConfig(db, params.workspaceId, params.id); // 404 if cross-workspace
  await db
    .update(workspaces)
    .set({ defaultLlmProviderConfigId: params.id, updatedAt: new Date() })
    .where(eq(workspaces.id, params.workspaceId));
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'workspace.default_provider_changed',
    resourceType: 'llm_provider_config',
    resourceId: params.id,
  });
}

export interface ValidationResult {
  status: 'valid' | 'invalid';
  model: string;
  message: string;
}

/**
 * Validate connectivity by sending a tiny prompt to the provider. Records the
 * outcome on the config and writes an audit event. Never surfaces raw provider
 * error bodies to the caller.
 */
export async function validateProviderConfig(
  db: Database,
  masterKey: string,
  params: { workspaceId: string; id: string; actorUserId: string; allowPrivateHosts: boolean },
): Promise<ValidationResult> {
  const config = await getProviderConfig(db, params.workspaceId, params.id);
  await assertSafeProviderUrl(config.baseUrl, { allowPrivate: params.allowPrivateHosts });
  const apiKey = await readSecretForUse(db, masterKey, config.secretId);

  let result: ValidationResult;
  try {
    await openAICompatibleComplete(
      {
        baseUrl: config.baseUrl,
        apiKey,
        model: config.modelName,
        label: config.displayName,
        requireApiKey: true,
        timeoutMs: config.timeoutSeconds * 1000,
        redirect: 'error',
      },
      {
        system: 'You are a connection validator.',
        user: 'Return the JSON object {"ok": true}.',
        maxTokens: 32,
      },
    );
    result = { status: 'valid', model: config.modelName, message: 'Provider connection validated successfully.' };
  } catch (err) {
    const status = err instanceof LLMError ? err.status : undefined;
    result = {
      status: 'invalid',
      model: config.modelName,
      message: 'Could not validate this AI provider. Check the base URL, API key, and model name.',
    };
    // Store a short, non-sensitive reason for admins (no raw provider body).
    await db
      .update(llmProviderConfigs)
      .set({
        validationStatus: 'invalid',
        lastValidatedAt: new Date(),
        validationError: status ? `Provider error (status ${status})` : 'Provider unreachable',
      })
      .where(eq(llmProviderConfigs.id, config.id));
    await writeAudit(db, {
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
      action: 'llm_provider.validated',
      resourceType: 'llm_provider_config',
      resourceId: config.id,
      metadata: { status: 'invalid' },
    });
    return result;
  }

  await db
    .update(llmProviderConfigs)
    .set({ validationStatus: 'valid', lastValidatedAt: new Date(), validationError: null })
    .where(eq(llmProviderConfigs.id, config.id));
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'llm_provider.validated',
    resourceType: 'llm_provider_config',
    resourceId: config.id,
    metadata: { status: 'valid' },
  });
  return result;
}
