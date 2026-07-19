import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../db/testing.js';
import { auditLogs, secrets } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { registerUser } from '../auth/service.js';
import { decryptSecret, encryptSecret } from './encryption.js';
import { createSecret, readSecretForUse, rotateSecret } from './service.js';

const MASTER_KEY = randomBytes(32).toString('base64');
const SECRET_VALUE = 'sk-super-secret-api-key-123';

describe('encryption (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const { value } = encryptSecret(SECRET_VALUE, MASTER_KEY);
    expect(value).not.toContain(SECRET_VALUE);
    expect(decryptSecret(value, MASTER_KEY)).toBe(SECRET_VALUE);
  });

  it('rejects a tampered ciphertext', () => {
    const { value } = encryptSecret(SECRET_VALUE, MASTER_KEY);
    const buf = Buffer.from(value, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptSecret(buf.toString('base64'), MASTER_KEY)).toThrow();
  });

  it('fails to decrypt with a different key', () => {
    const { value } = encryptSecret(SECRET_VALUE, MASTER_KEY);
    expect(() => decryptSecret(value, randomBytes(32).toString('base64'))).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encryptSecret(SECRET_VALUE, 'short')).toThrow();
  });
});

describe('secret vault service', () => {
  let db: Database;
  let close: () => Promise<void>;
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    const { user, workspace } = await registerUser(db, {
      email: 'vault@example.com',
      password: 'password123',
    });
    userId = user.id;
    workspaceId = workspace.id;
  });
  afterEach(async () => {
    await close();
  });

  it('stores ciphertext at rest, not the plaintext', async () => {
    const secret = await createSecret(db, MASTER_KEY, {
      workspaceId,
      name: 'OpenRouter key',
      type: 'llm_api_key',
      value: SECRET_VALUE,
      createdByUserId: userId,
    });
    const [row] = await db.select().from(secrets).where(eq(secrets.id, secret.id));
    expect(row!.encryptedValue).not.toContain(SECRET_VALUE);
    // and the only way back is via the vault
    expect(await readSecretForUse(db, MASTER_KEY, secret.id)).toBe(SECRET_VALUE);
  });

  it('writes audit events for create and rotate (never the value)', async () => {
    const secret = await createSecret(db, MASTER_KEY, {
      workspaceId,
      name: 'k',
      type: 'llm_api_key',
      value: SECRET_VALUE,
      createdByUserId: userId,
    });
    await rotateSecret(db, MASTER_KEY, {
      workspaceId,
      secretId: secret.id,
      newValue: 'sk-rotated-value-456',
      actorUserId: userId,
    });

    const events = await db.select().from(auditLogs);
    const actions = events.map((e) => e.action);
    expect(actions).toContain('secret.created');
    expect(actions).toContain('secret.rotated');
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);

    // rotation actually changed the stored value
    expect(await readSecretForUse(db, MASTER_KEY, secret.id)).toBe('sk-rotated-value-456');
  });
});
