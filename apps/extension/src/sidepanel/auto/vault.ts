/**
 * Session credential vault access for the panel (auto-test-mode-spec §9.4,
 * §10): values live only in chrome.storage.session under `autoVault` — the
 * same key the SW's readVault uses — and never transit runtime messaging (the
 * panel is a trusted context; M4 note). The UI lists names only; values are
 * write-only from the panel's perspective.
 */

export const VAULT_KEY = 'autoVault';

/** Minimal storage-area surface so unit tests can pass a fake. */
export interface KeyValueArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const sessionArea = (): KeyValueArea => chrome.storage.session;

/** Placeholder names are UPPER_SNAKE (matching `{{NAME}}` fill tokens). */
export function normalizeCredentialName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

async function readVault(area: KeyValueArea): Promise<Record<string, string>> {
  const stored = await area.get(VAULT_KEY);
  const vault = stored[VAULT_KEY];
  return vault && typeof vault === 'object' ? { ...(vault as Record<string, string>) } : {};
}

export async function listCredentialNames(area: KeyValueArea = sessionArea()): Promise<string[]> {
  return Object.keys(await readVault(area));
}

/** Returns the updated name list; the value itself is never read back. */
export async function addCredential(
  name: string,
  value: string,
  area: KeyValueArea = sessionArea(),
): Promise<string[]> {
  const normalized = normalizeCredentialName(name);
  if (!normalized || !value) return listCredentialNames(area);
  const vault = await readVault(area);
  vault[normalized] = value;
  await area.set({ [VAULT_KEY]: vault });
  return Object.keys(vault);
}

export async function removeCredential(
  name: string,
  area: KeyValueArea = sessionArea(),
): Promise<string[]> {
  const vault = await readVault(area);
  delete vault[name];
  await area.set({ [VAULT_KEY]: vault });
  return Object.keys(vault);
}

export async function clearCredentials(area: KeyValueArea = sessionArea()): Promise<string[]> {
  await area.set({ [VAULT_KEY]: {} });
  return [];
}
