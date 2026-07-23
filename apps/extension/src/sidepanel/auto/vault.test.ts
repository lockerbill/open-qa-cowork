import { describe, expect, it } from 'vitest';
import {
  addCredential,
  clearCredentials,
  listCredentialNames,
  normalizeCredentialName,
  removeCredential,
  VAULT_KEY,
  type KeyValueArea,
} from './vault.js';

/** In-memory stand-in for chrome.storage.session. */
function fakeArea(): KeyValueArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: (key) => Promise.resolve(key in data ? { [key]: data[key] } : {}),
    set: (items) => {
      Object.assign(data, items);
      return Promise.resolve();
    },
  };
}

describe('credential vault (§9.4, §10)', () => {
  it('normalizes names to UPPER_SNAKE placeholder form', () => {
    expect(normalizeCredentialName(' test user password ')).toBe('TEST_USER_PASSWORD');
    expect(normalizeCredentialName('api-key.2')).toBe('API_KEY_2');
  });

  it('stores values only under the session vault key and returns names only', async () => {
    const area = fakeArea();
    const names = await addCredential('test password', 'Secret123!', area);
    expect(names).toEqual(['TEST_PASSWORD']);
    // The value lives in the (session) area, under the SW's shared key…
    expect(area.data).toEqual({ [VAULT_KEY]: { TEST_PASSWORD: 'Secret123!' } });
    // …and every read-back surface exposes names only.
    expect(await listCredentialNames(area)).toEqual(['TEST_PASSWORD']);
  });

  it('ignores empty names and empty values', async () => {
    const area = fakeArea();
    expect(await addCredential('   ', 'v', area)).toEqual([]);
    expect(await addCredential('NAME', '', area)).toEqual([]);
    expect(area.data).toEqual({});
  });

  it('removes a single credential', async () => {
    const area = fakeArea();
    await addCredential('A', '1', area);
    await addCredential('B', '2', area);
    expect(await removeCredential('A', area)).toEqual(['B']);
    expect(area.data[VAULT_KEY]).toEqual({ B: '2' });
  });

  it('clears all credentials', async () => {
    const area = fakeArea();
    await addCredential('A', '1', area);
    expect(await clearCredentials(area)).toEqual([]);
    expect(area.data[VAULT_KEY]).toEqual({});
  });
});
