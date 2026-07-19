import type { PageModel, TestSession } from '@qa-copilot/shared';
import { DEFAULT_SETTINGS, EMPTY_AUTH, type AuthState, type Settings } from './messages.js';

const SETTINGS_KEY = 'settings';
const SESSION_KEY = 'session';
const PAGE_MODEL_KEY = 'pageModel';
const AUTH_KEY = 'auth';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function newSession(): TestSession {
  return {
    id: `session_${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'idle',
    events: [],
    evidence: [],
    consoleErrors: [],
    networkFailures: [],
  };
}

export async function getSession(): Promise<TestSession> {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return (stored[SESSION_KEY] as TestSession | undefined) ?? newSession();
}

export async function saveSession(session: TestSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function getAuth(): Promise<AuthState> {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return { ...EMPTY_AUTH, ...(stored[AUTH_KEY] as Partial<AuthState> | undefined) };
}

export async function saveAuth(auth: AuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: EMPTY_AUTH });
}

/** Read-modify-write the stored auth. Callers serialize via the background mutex. */
export async function updateAuth(mutate: (auth: AuthState) => void): Promise<AuthState> {
  const auth = await getAuth();
  mutate(auth);
  await saveAuth(auth);
  return auth;
}

export async function getPageModel(): Promise<PageModel | null> {
  const stored = await chrome.storage.local.get(PAGE_MODEL_KEY);
  return (stored[PAGE_MODEL_KEY] as PageModel | undefined) ?? null;
}

export async function savePageModel(model: PageModel | null): Promise<void> {
  await chrome.storage.local.set({ [PAGE_MODEL_KEY]: model });
}
