import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key version written by the current code path; future rotations bump this. */
export const CURRENT_KEY_VERSION = 1;

function loadKey(masterKey: string): Buffer {
  const key = Buffer.from(masterKey, 'base64');
  if (key.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

/**
 * Encrypt a secret with AES-256-GCM. The returned value is base64 of
 * `iv | authTag | ciphertext`; store it in `secrets.encryptedValue`.
 */
export function encryptSecret(
  plaintext: string,
  masterKey: string,
): { value: string; keyVersion: number } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, loadKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value: Buffer.concat([iv, tag, ciphertext]).toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/** Decrypt a value produced by {@link encryptSecret}. Throws if tampered or wrong key. */
export function decryptSecret(value: string, masterKey: string): string {
  const buf = Buffer.from(value, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, loadKey(masterKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
