import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { genId } from '../../db/id.js';
import { secrets } from '../../db/schema.js';
import { writeAudit } from '../../audit/index.js';
import { ApiError } from '../../http/errors.js';
import { decryptSecret, encryptSecret } from './encryption.js';

export type Secret = typeof secrets.$inferSelect;

/** Kinds of secret the vault stores. Module-local — no route projects it. */
type SecretType = 'llm_api_key' | 'jira_refresh_token' | 'generic_api_key';

/** Encrypt and store a secret. Writes a `secret.created` audit event (no value). */
export async function createSecret(
  db: Database,
  masterKey: string,
  params: {
    workspaceId: string;
    name: string;
    type: SecretType;
    value: string;
    createdByUserId: string;
    ownerUserId?: string;
  },
): Promise<Secret> {
  const { value, keyVersion } = encryptSecret(params.value, masterKey);
  const [secret] = await db
    .insert(secrets)
    .values({
      id: genId('sec'),
      workspaceId: params.workspaceId,
      ownerUserId: params.ownerUserId ?? null,
      name: params.name,
      type: params.type,
      encryptedValue: value,
      encryptionKeyVersion: keyVersion,
      createdByUserId: params.createdByUserId,
    })
    .returning();
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.createdByUserId,
    action: 'secret.created',
    resourceType: 'secret',
    resourceId: secret!.id,
    metadata: { name: params.name, type: params.type },
  });
  return secret!;
}

/**
 * Decrypt a secret for server-internal use (the provider call path). Updates
 * `lastUsedAt`. The returned plaintext must never be logged or returned to a
 * client.
 */
export async function readSecretForUse(
  db: Database,
  masterKey: string,
  secretId: string,
): Promise<string> {
  const [secret] = await db.select().from(secrets).where(eq(secrets.id, secretId));
  if (!secret) throw new ApiError(404, 'Secret not found');
  await db.update(secrets).set({ lastUsedAt: new Date() }).where(eq(secrets.id, secret.id));
  return decryptSecret(secret.encryptedValue, masterKey);
}

/** Replace a secret's value (re-encrypts). Writes a `secret.rotated` audit event. */
export async function rotateSecret(
  db: Database,
  masterKey: string,
  params: { workspaceId: string; secretId: string; newValue: string; actorUserId: string },
): Promise<void> {
  const { value, keyVersion } = encryptSecret(params.newValue, masterKey);
  const result = await db
    .update(secrets)
    .set({ encryptedValue: value, encryptionKeyVersion: keyVersion, rotatedAt: new Date() })
    .where(eq(secrets.id, params.secretId))
    .returning({ id: secrets.id });
  if (result.length === 0) throw new ApiError(404, 'Secret not found');
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'secret.rotated',
    resourceType: 'secret',
    resourceId: params.secretId,
  });
}

/** Permanently remove a secret. Writes a `secret.deleted` audit event (no value). */
export async function deleteSecret(
  db: Database,
  params: { workspaceId: string; secretId: string; actorUserId: string },
): Promise<void> {
  const result = await db
    .delete(secrets)
    .where(eq(secrets.id, params.secretId))
    .returning({ id: secrets.id });
  if (result.length === 0) throw new ApiError(404, 'Secret not found');
  await writeAudit(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    action: 'secret.deleted',
    resourceType: 'secret',
    resourceId: params.secretId,
  });
}
